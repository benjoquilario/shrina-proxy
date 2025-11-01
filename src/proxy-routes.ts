import express, { Request, Response, NextFunction, Router } from 'express';
import fetch from 'node-fetch';
import { URL } from 'url';
import https from 'https';
import { PROXY, ROUTES, SERVER } from './config/constants.js';
import { logger } from './middleware.js';
import { generateHeadersForUrl } from './config/domain-templates.js';
import { isM3u8Playlist, getMimeType } from './config/mime-types.js';
import { processM3u8Content } from './utils/m3u8-handler.js';
import { 
  validateUrl, 
  determineContentType, 
  processVttContent,
  decodeImageUrl,
  encodeImageUrl,
  isImageUrl,
  isObfuscatedVideoSegment
} from './utils/helpers.js';
import { decompressWithWorker, getWorkerStats } from './utils/worker-pool.js';
import {
  generateCacheKey, 
  getCacheItem, 
  setCacheItem, 
  getCacheStats, 
  clearCache 
} from './utils/cache.js';
import {
  recordRequest,
  recordResponse,
  recordStreamingRequest,
  recordCacheHit,
  recordCacheMiss,
  recordWorkerTask,
  getPerformanceMetrics,
  resetMetrics
} from './utils/performance-monitor.js';

const router: Router = express.Router();

// Create an HTTPS agent that doesn't validate certificates for redirects
// This is necessary because some CDNs redirect to different domains
const httpsAgent = new https.Agent({
  rejectUnauthorized: false, // Disable certificate validation
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: PROXY.REQUEST_TIMEOUT,
});

// Extend Express Request type to include targetUrl
declare global {
  namespace Express {
    interface Request {
      targetUrl?: string;
    }
  }
}

/**
 * URL parameter validator middleware
 */
const validateUrlParam = (req: Request, res: Response, next: NextFunction) => {
  let url: string | undefined;
  
  // Check for URL in query parameter
  if (req.query.url) {
    url = req.query.url as string;
  } 
  // Check for URL in path parameter (using named param)
  else if (req.params.url) {
    url = req.params.url;
    // If it doesn't start with http(s)://, add it
    if (!/^https?:\/\//i.test(url)) {
      url = `https://${url}`;
    }
  } 
  // Check for base64 encoded URL
  else if (req.params.encodedUrl) {
    try {
      url = Buffer.from(req.params.encodedUrl, 'base64').toString('utf-8');
    } catch (error) {
      return res.status(400).json({
        error: {
          code: 400,
          message: 'Invalid base64 encoded URL',
        },
        success: false,
        timestamp: new Date().toISOString(),
      });
    }
  }
  
  // Validate URL
  if (!url) {
    return res.status(400).json({
      error: {
        code: 400,
        message: 'Missing URL parameter',
        usage: 'Use ?url=https://example.com',
      },
      success: false,
      timestamp: new Date().toISOString(),
    });
  }
  
  // Validate URL format and against whitelist
  const validation = validateUrl(url, {
    maxUrlLength: PROXY.MAX_REQUEST_SIZE,
    allowedDomains: PROXY.ENABLE_DOMAIN_WHITELIST ? PROXY.ALLOWED_DOMAINS : [],
  });
  
  if (!validation.valid) {
    return res.status(400).json({
      error: {
        code: 400,
        message: validation.reason || 'Invalid URL',
        url,
      },
      success: false,
      timestamp: new Date().toISOString(),
    });
  }
  
  // Store validated URL in request object
  req.targetUrl = url;
  next();
};


/**
 * Stream proxy request handler
 * Used for large files and media streaming
 */
async function streamProxyRequest(req: Request, res: Response, url: string, headers: Record<string, string>) {
  const requestStartTime = recordRequest();
  let responseSize = 0;
  
  // Track response size for streams
  const originalWrite = res.write;
  // @ts-ignore
  res.write = function(chunk) {
    if (chunk) {
      responseSize += chunk.length || 0;
    }
    return originalWrite.apply(res, arguments as any);
  };
  
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), PROXY.REQUEST_TIMEOUT);
  
  try {
    // Perform the fetch request
    const response = await fetch(url, {
      method: req.method,
      headers,
      signal: abortController.signal,
      agent: url.startsWith('https') ? httpsAgent : undefined,
    });
    
    clearTimeout(timeoutId);
    
    // Handle error responses
    if (response.status >= 400) {
      logger.warn({
        type: 'stream-proxy',
        url,
        status: response.status,
        statusText: response.statusText,
      }, `Proxy received error status: ${response.status} ${response.statusText}`);
      
      // Forward the status code
      res.status(response.status);
      
      // Try to get error body if possible
      try {
        const errorBody = await response.text();
        try {
          const jsonBody = JSON.parse(errorBody);
          recordResponse(requestStartTime, false, 0, errorBody.length);
          return res.json(jsonBody);
        } catch (e) {
          recordResponse(requestStartTime, false, 0, errorBody.length);
          return res.send(errorBody);
        }
      } catch (e) {
        recordResponse(requestStartTime, false, 0, 0);
        return res.end();
      }
    }
    
    if (process.env.USE_CLOUDFLARE === 'true') {
      // Ensure Cloudflare doesn't buffer responses
      res.setHeader('X-Accel-Buffering', 'no');
      
      // Hint to Cloudflare that this is streaming content
      res.setHeader('CF-Cache-Status', 'DYNAMIC');
    }

    // Get content type and other headers
    const contentType = response.headers.get('content-type');
    const contentLength = response.headers.get('content-length');
    const contentEncoding = response.headers.get('content-encoding');
    const isCompressed = !!contentEncoding && 
                         ['gzip', 'br', 'deflate', 'zstd'].includes(contentEncoding.toLowerCase());
    
    // Selectively forward important response headers (following Rust proxy pattern)
    const importantHeaders = [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'cache-control',
      'expires',
      'last-modified',
      'etag',
      'content-encoding',
      'vary',
    ];
    
    for (const [key, value] of Object.entries(response.headers.raw())) {
      const keyLower = key.toLowerCase();
      if (importantHeaders.includes(keyLower)) {
        res.setHeader(key, value);
      }
    }
    
    // Add comprehensive CORS headers (following Rust proxy pattern)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD, PUT, DELETE, PATCH');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range, X-Requested-With, Origin, Accept, Accept-Encoding, Accept-Language, Cache-Control, Pragma, Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site, Sec-Ch-Ua, Sec-Ch-Ua-Mobile, Sec-Ch-Ua-Platform, Connection, If-Range, If-None-Match, If-Modified-Since');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type, Cache-Control, Expires, Vary, ETag, Last-Modified, Content-Encoding');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Vary', 'Origin');
    
    // Set status code
    res.status(response.status);
    
    // For large files, record as streaming request
    if (contentLength && parseInt(contentLength, 10) > 1024 * 1024) {
      recordStreamingRequest(parseInt(contentLength, 10));
    }
    
    // Handle different content types and compression scenarios
    
    // Check if this is an obfuscated video segment
    const isObfuscated = isObfuscatedVideoSegment(url, contentType);
    
    // Case 1: Compressed content that needs special processing (m3u8, vtt, srt)
    // Skip decompression for obfuscated segments
    if (isCompressed && !isObfuscated && ['m3u8', 'vtt', 'srt'].some(ext => url.toLowerCase().endsWith(`.${ext}`))) {
      // For text-based formats that need processing but are compressed,
      // we need to decompress fully first
      const arrayBuffer = await response.arrayBuffer();
      const buffer = await decompressWithWorker(Buffer.from(arrayBuffer), contentEncoding);
      
      // Process content if needed
      if (isM3u8Playlist(url)) {
        const responseText = new TextDecoder('utf-8').decode(buffer);
        const processedContent = processM3u8Content(responseText, {
          proxyBaseUrl: ROUTES.PROXY_BASE,
          targetUrl: url,
          urlParamName: 'url',
          preserveQueryParams: true,
        });
        
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.removeHeader('content-encoding');
        recordResponse(requestStartTime, true, arrayBuffer.byteLength, processedContent.length);
        return res.send(processedContent);
      } else if (contentType?.includes('text/vtt')) {
        const responseText = new TextDecoder('utf-8').decode(buffer);
        const processedContent = processVttContent(responseText, {
          proxyBaseUrl: ROUTES.PROXY_BASE,
          targetUrl: url,
          urlParamName: 'url',
        });
        
        res.setHeader('Content-Type', 'text/vtt');
        res.removeHeader('content-encoding');
        recordResponse(requestStartTime, true, arrayBuffer.byteLength, processedContent.length);
        return res.send(processedContent);
      }
      
      // If no special processing needed but still compressed
      res.removeHeader('content-encoding');
      recordResponse(requestStartTime, true, arrayBuffer.byteLength, buffer.length);
      return res.send(buffer);
    } 
    // Case 2: Uncompressed content that needs special processing (m3u8, vtt)
    else if (isM3u8Playlist(url) || contentType?.includes('text/vtt')) {
      try {
        // Get the full text response instead of using getReader()
        const responseText = await response.text();
        
        // Process content
        if (isM3u8Playlist(url)) {
          const processedContent = processM3u8Content(responseText, {
            proxyBaseUrl: ROUTES.PROXY_BASE,
            targetUrl: url,
            urlParamName: 'url',
            preserveQueryParams: true,
          });
          
          res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
          recordResponse(requestStartTime, true, responseText.length, processedContent.length);
          return res.send(processedContent);
        } else if (contentType?.includes('text/vtt')) {
          const processedContent = processVttContent(responseText, {
            proxyBaseUrl: ROUTES.PROXY_BASE,
            targetUrl: url,
            urlParamName: 'url',
          });
          
          res.setHeader('Content-Type', 'text/vtt');
          recordResponse(requestStartTime, true, responseText.length, processedContent.length);
          return res.send(processedContent);
        }
      } catch (error) {
        logger.error({
          type: 'stream-proxy',
          url,
          error: error instanceof Error ? error.message : String(error),
        }, 'Error processing text-based format');
        
        // Fall through to buffer-based approach on error
      }
    } 
    // Case 3: Compressed content that doesn't need special processing
    else if (isCompressed && !isObfuscated) {
      // For compressed content that doesn't need special processing,
      // we can't stream it directly as the client expects uncompressed
      const arrayBuffer = await response.arrayBuffer();
      const buffer = await decompressWithWorker(Buffer.from(arrayBuffer), contentEncoding);
      
      res.removeHeader('content-encoding');
      recordResponse(requestStartTime, true, arrayBuffer.byteLength, buffer.length);
      return res.send(buffer);
    }
    // Case 3b: Obfuscated segments with fake compression headers
    else if (isObfuscated && isCompressed) {
      // These files claim compression but aren't actually compressed
      // Stream them directly without decompression
      logger.debug({
        type: 'stream-proxy',
        url,
        contentType,
        note: 'Obfuscated segment - skipping decompression'
      }, 'Detected obfuscated video segment');
      
      // Keep the content-encoding header as-is (browser will handle it)
      // Just stream the content directly
      if (response.body) {
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        recordResponse(requestStartTime, true, 0, buffer.length);
        return res.send(buffer);
      }
    } 
    // Case 4: Uncompressed content that doesn't need special processing - direct streaming
    else if (response.body) {
      // Set X-Accel-Buffering header to disable nginx buffering
      res.setHeader('X-Accel-Buffering', 'no');
      
      // Handle direct streaming in a Node.js compatible way
      try {
        // Check if we can access response.body as a Node.js stream
        if (typeof response.body.pipe === 'function') {
          // It's a Node.js Readable stream
          response.body.pipe(res);
          
          // Log success
          logger.debug({
            type: 'stream-proxy',
            url,
            method: 'pipe',
            contentType: contentType || 'unknown'
          }, 'Streaming response using pipe');
          
          // Set up event handlers
          response.body.on('end', () => {
            recordResponse(requestStartTime, true, 0, responseSize);
            logger.debug({
              type: 'stream-proxy',
              url,
              method: 'pipe',
              bytesTransferred: responseSize
            }, 'Stream completed');
          });
          
          response.body.on('error', (err) => {
            recordResponse(requestStartTime, false, 0, responseSize);
            logger.error({
              type: 'stream-proxy',
              url,
              method: 'pipe',
              error: err instanceof Error ? err.message : String(err)
            }, 'Stream error');
            
            // Only end response if it hasn't been sent yet
            if (!res.headersSent) {
              res.status(500).end();
            } else if (!res.writableEnded) {
              res.end();
            }
          });
          
          // This prevents the function from continuing, as response is now handled by pipe
          return;
        } else {
          // For newer fetch implementations with Web API ReadableStream
          // Use arrayBuffer as fallback since we can't directly pipe
          logger.debug({
            type: 'stream-proxy',
            url,
            method: 'buffer',
            reason: 'readable-stream-not-available'
          }, 'Falling back to buffer approach');
          
          const buffer = await response.arrayBuffer();
          recordResponse(requestStartTime, true, 0, buffer.byteLength);
          return res.send(Buffer.from(buffer));
        }
      } catch (error) {
        // If stream handling fails, fall back to buffer approach
        logger.warn({
          type: 'stream-proxy',
          url,
          error: error instanceof Error ? error.message : String(error),
          fallback: 'using-buffer'
        }, 'Stream handling failed, using buffer fallback');
        
        try {
          const buffer = await response.arrayBuffer();
          recordResponse(requestStartTime, true, 0, buffer.byteLength);
          return res.send(Buffer.from(buffer));
        } catch (err) {
          recordResponse(requestStartTime, false, 0, 0);
          logger.error({
            type: 'stream-proxy',
            url,
            error: err instanceof Error ? err.message : String(err)
          }, 'Buffer fallback failed');
          
          if (!res.headersSent) {
            return res.status(500).json({
              error: {
                code: 500,
                message: 'Failed to process content',
                url
              },
              success: false,
              timestamp: new Date().toISOString()
            });
          } else if (!res.writableEnded) {
            return res.end();
          }
        }
      }
    }
    
    // Fallback for any other scenarios not caught above
    try {
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      
      if (contentEncoding) {
        const decompressed = await decompressWithWorker(buffer, contentEncoding);
        res.removeHeader('content-encoding');
        recordResponse(requestStartTime, true, buffer.length, decompressed.length);
        return res.send(decompressed);
      }
      
      recordResponse(requestStartTime, true, 0, buffer.length);
      return res.send(buffer);
    } catch (error) {
      recordResponse(requestStartTime, false, 0, 0);
      logger.error({
        type: 'stream-proxy',
        url,
        error: error instanceof Error ? error.message : String(error)
      }, 'Final fallback failed');
      
      if (!res.headersSent) {
        return res.status(500).json({
          error: {
            code: 500,
            message: 'Failed to process content',
            url
          },
          success: false,
          timestamp: new Date().toISOString()
        });
      } else if (!res.writableEnded) {
        return res.end();
      }
    }
  } catch (error) {
    clearTimeout(timeoutId);
    
    // Handle proxy errors
    logger.error({
      type: 'stream-proxy',
      url,
      error: error instanceof Error ? error.message : String(error),
    }, 'Stream proxy request failed');
    
    // Determine appropriate error message and status
    let statusCode = 500;
    let errorMessage = 'Failed to proxy request';
    
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        statusCode = 504;
        errorMessage = `Request timed out after ${PROXY.REQUEST_TIMEOUT}ms`;
      } else {
        errorMessage = error.message || errorMessage;
      }
    }
    
    recordResponse(requestStartTime, false, 0, 0);
    
    if (!res.headersSent) {
      res.status(statusCode).json({
        error: {
          code: statusCode,
          message: errorMessage,
          url,
        },
        success: false,
        timestamp: new Date().toISOString(),
      });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}

/**
 * Main proxy request handler
 */
async function proxyRequest(req: Request, res: Response, next: NextFunction) {
  const url = req.targetUrl;
  
  if (!url) {
    return next(new Error('Target URL is required'));
  }
  
  const requestStartTime = recordRequest();
  let responseSize = 0;
  let requestSize = req.headers['content-length'] ? parseInt(req.headers['content-length'] as string, 10) : 0;
  
  // Track response size by intercepting res.send
  const originalSend = res.send;
  // @ts-ignore
  res.send = function(body) {
    try {
      responseSize = body?.length || 0;
    } catch (e) {
      responseSize = 0;
    }
    return originalSend.apply(res, arguments as any);
  };
  
  try {
    // Log the request
    logger.debug({
      type: 'proxy',
      url,
      method: req.method,
      headers: req.headers,
    }, `Proxying request to ${url}`);
    
    // Check cache first for GET requests
    if (req.method === 'GET') {
      // Generate cache key based on URL and relevant headers
      const cacheKey = generateCacheKey(url, req.headers);
      
      // Try to get from cache
      const cachedItem = getCacheItem(cacheKey);
      if (cachedItem) {
        // If found in cache, send directly
        recordCacheHit();
        const contentType = determineContentType(cachedItem.data, null, url);
        if (contentType) {
          res.setHeader('Content-Type', contentType);
        }
        
        // Set cache-hit header for debugging
        res.setHeader('X-Cache', 'HIT');
        
        // Add CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Range');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type, Accept-Ranges');
        
        // If we have a range request and cached the full response
        if (req.headers.range) {
          const range = req.headers.range;
          const match = range.match(/bytes=(\d+)-(\d+)?/);
          
          if (match) {
            const start = parseInt(match[1], 10);
            const end = match[2] ? parseInt(match[2], 10) : cachedItem.data.length - 1;
            
            // Validate range request
            if (start >= 0 && end < cachedItem.data.length && start <= end) {
              const slice = cachedItem.data.slice(start, end + 1);
              res.setHeader('Content-Range', `bytes ${start}-${end}/${cachedItem.data.length}`);
              res.setHeader('Content-Length', slice.length.toString());
              res.status(206);
              recordResponse(requestStartTime, true, 0, slice.length);
              return res.send(slice);
            }
          }
        }
        
        // Regular request, send full cached response
        recordResponse(requestStartTime, true, 0, cachedItem.data.length);
        return res.send(cachedItem.data);
      } else {
        recordCacheMiss();
        // If not in cache, set a header for debugging
        res.setHeader('X-Cache', 'MISS');
      }
    }
    
    // Set up request headers
    const headers: Record<string, string> = {};
    
    // Forward headers, excluding those that should be removed
    const excludeHeaders = [
      'host',
      'connection',
      'content-length',
      'forwarded',
      'x-forwarded-for',
      'x-forwarded-host',
      'x-forwarded-proto',
    ];
    
    for (const [key, value] of Object.entries(req.headers)) {
      if (!excludeHeaders.includes(key.toLowerCase()) && value) {
        headers[key] = Array.isArray(value) ? value.join(', ') : value;
      }
    }
    
    // Parse the target URL
    const targetUrl = new URL(url);
    
    // Apply domain-specific header templates
    const domainHeaders = generateHeadersForUrl(targetUrl);
    Object.assign(headers, domainHeaders);
    
    // Set host header to match target URL
    headers['host'] = targetUrl.host;
    
    // Forward important client request headers for caching and range requests
    if (req.headers.range) {
      headers['range'] = req.headers.range as string;
      logger.debug({
        type: 'range-request',
        url,
        range: req.headers.range
      }, 'Forwarding Range header');
    }
    
    // Forward conditional request headers (for HTTP caching)
    if (req.headers['if-range']) {
      headers['if-range'] = req.headers['if-range'] as string;
    }
    if (req.headers['if-none-match']) {
      headers['if-none-match'] = req.headers['if-none-match'] as string;
    }
    if (req.headers['if-modified-since']) {
      headers['if-modified-since'] = req.headers['if-modified-since'] as string;
    }
    
    // Get request body for non-GET requests
    let body: any = null;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      body = req.body;
    }
    
    // For GET requests that benefit from streaming (large files, media)
    // Use the streaming approach
    const STREAM_SIZE_THRESHOLD = parseInt(process.env.STREAM_SIZE_THRESHOLD || '1048576', 10);
    const ENABLE_STREAMING = process.env.ENABLE_STREAMING !== 'false';
    
    if (ENABLE_STREAMING && req.method === 'GET' && 
        (url.endsWith('.ts') || 
         url.endsWith('.m3u8') || 
         url.endsWith('.mp4') || 
         url.endsWith('.mp3') || 
         url.endsWith('.m4s') || 
         url.includes('segment-'))) {
      return streamProxyRequest(req, res, url, headers);
    }
    
    // For other requests, use the classic approach
    // Perform the fetch request
    const startTime = Date.now();
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), PROXY.REQUEST_TIMEOUT);
    
    try {
      const response = await fetch(url, {
        method: req.method,
        headers,
        body,
        redirect: 'follow',
        signal: abortController.signal,
        agent: url.startsWith('https') ? httpsAgent : undefined,
      });
      
      clearTimeout(timeoutId);
      
      // Get content type from response
      const contentType = response.headers.get('content-type');
      const contentEncoding = response.headers.get('content-encoding');
      const contentLength = response.headers.get('content-length');
      
      // Check if this is a large file that should be streamed
      if (ENABLE_STREAMING && 
          contentLength && 
          parseInt(contentLength, 10) > STREAM_SIZE_THRESHOLD && 
          req.method === 'GET') {
        // Use streaming for large files
        return streamProxyRequest(req, res, url, headers);
      }
      
      // Check if this is an audio segment
      const isAudioSegment = contentType?.includes('audio/mp4') || 
                             contentType?.includes('audio/aac') ||
                             url.includes('.aac') ||
                             url.toLowerCase().includes('mp4a.40');
      
      // Special debug for audio segments
      if (isAudioSegment) {
        logger.debug({
          type: 'audio-segment',
          url,
          contentType,
          status: response.status,
          range: req.headers.range,
          responseContentRange: response.headers.get('content-range'),
          responseHeaders: Object.fromEntries(response.headers.entries()),
        }, 'Audio segment debug info');
      }
      
      // Log response headers for debugging
      logger.debug({
        type: 'proxy',
        url,
        status: response.status,
        contentType,
        contentEncoding,
        responseHeaders: Object.fromEntries(response.headers.entries()),
      }, `Response headers for ${url}`);
      
      // Detect M3U8 content by content-type or extension if not already determined
      const isM3u8Content = isM3u8Playlist(url) || 
                          contentType?.includes('application/vnd.apple.mpegurl') || 
                          contentType?.includes('application/x-mpegurl') ||
                          url.toLowerCase().endsWith('.m3u8');
      
      // Selectively forward important response headers (following Rust proxy pattern)
      const importantHeaders = [
        'content-type',
        'content-length',
        'content-range',
        'accept-ranges',
        'cache-control',
        'expires',
        'last-modified',
        'etag',
        'vary',
      ];
      
      // Add content-encoding for audio segments
      if (isAudioSegment) {
        importantHeaders.push('content-encoding');
      }
      
      for (const [key, value] of Object.entries(response.headers.raw())) {
        const keyLower = key.toLowerCase();
        if (importantHeaders.includes(keyLower)) {
          res.setHeader(key, value);
        }
      }
      
      // Always include Accept-Ranges for media segments
      if (!res.getHeader('Accept-Ranges') && (isAudioSegment || url.endsWith('.ts'))) {
        res.setHeader('Accept-Ranges', 'bytes');
      }
      
      // Add comprehensive CORS headers (following Rust proxy pattern)
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD, PUT, DELETE, PATCH');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range, X-Requested-With, Origin, Accept, Accept-Encoding, Accept-Language, Cache-Control, Pragma, Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site, Sec-Ch-Ua, Sec-Ch-Ua-Mobile, Sec-Ch-Ua-Platform, Connection, If-Range, If-None-Match, If-Modified-Since');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type, Cache-Control, Expires, Vary, ETag, Last-Modified, Content-Encoding');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Vary', 'Origin');
      
      // Handle error status codes (4xx, 5xx) properly
      if (response.status >= 400) {
        logger.warn({
          type: 'proxy',
          url,
          status: response.status,
          statusText: response.statusText,
          responseTime: Date.now() - startTime,
        }, `Proxy received error status: ${response.status} ${response.statusText}`);
        
        // Try to get error response text if possible
        let errorBody;
        try {
          // Try text first
          errorBody = await response.text();
        } catch (e) {
          // If text fails, return empty body
          errorBody = '';
        }
        
        // Forward the status code exactly as received
        res.status(response.status);
        
        recordResponse(requestStartTime, false, requestSize, errorBody.length);
        
        // Check if the error body is JSON
        try {
          const jsonBody = JSON.parse(errorBody);
          return res.json(jsonBody);
        } catch (e) {
          // Not JSON, return as text
          return res.send(errorBody);
        }
      }
      
      // Special handling for partial content (206) responses - especially for audio segments
      if (response.status === 206) {
        try {
          // Ensure Content-Range header is forwarded
          const contentRange = response.headers.get('content-range');
          if (contentRange) {
            res.setHeader('Content-Range', contentRange);
          }
          
          // Get the content as a buffer and send it directly
          const buffer = await response.arrayBuffer();
          
          // Set status code to 206 Partial Content
          res.status(206);
          
          logger.debug({
            type: 'partial-content',
            url,
            status: 206,
            contentType: res.getHeader('Content-Type'),
            contentRange: contentRange,
            responseTime: Date.now() - startTime,
            size: buffer.byteLength
          }, `Proxied partial content for ${url}`);
          
          const responseBuffer = Buffer.from(buffer);
          recordResponse(requestStartTime, true, requestSize, responseBuffer.length);
          
          // Return the buffer directly without modifying
          return res.send(responseBuffer);
        } catch (error) {
          logger.error({
            type: 'partial-content-error',
            url,
            error: error instanceof Error ? error.message : String(error),
          }, 'Error processing partial content');
          
          recordResponse(requestStartTime, false, requestSize, 0);
          
          return res.status(500).json({
            error: {
              code: 500,
              message: 'Failed to process partial content',
              url,
              details: error instanceof Error ? error.message : String(error)
            },
            success: false,
            timestamp: new Date().toISOString()
          });
        }
      }
      
      // Direct handling for audio segments
      if (isAudioSegment && response.status === 200) {
        try {
          // Get the content as a buffer and send it directly
          const buffer = await response.arrayBuffer();
          
          // Ensure content type is preserved exactly
          if (contentType) {
            res.setHeader('Content-Type', contentType);
          }
          
          logger.debug({
            type: 'audio',
            url,
            status: response.status,
            contentType: contentType,
            responseTime: Date.now() - startTime,
            size: buffer.byteLength
          }, `Proxied audio segment for ${url}`);
          
          const responseBuffer = Buffer.from(buffer);
          recordResponse(requestStartTime, true, requestSize, responseBuffer.length);
          
          // Return the buffer directly
          return res.send(responseBuffer);
        } catch (error) {
          logger.error({
            type: 'audio-error',
            url,
            error: error instanceof Error ? error.message : String(error),
          }, 'Error processing audio segment');
          
          recordResponse(requestStartTime, false, requestSize, 0);
          
          return res.status(500).json({
            error: {
              code: 500,
              message: 'Failed to process audio segment',
              url,
              details: error instanceof Error ? error.message : String(error)
            },
            success: false,
            timestamp: new Date().toISOString()
          });
        }
      }
      
      // Handle M3U8 playlists - requires special processing for URL rewriting
      if (isM3u8Content && response.status === 200) {
        try {
          // Get the content as a buffer first
          const responseBuffer = await response.arrayBuffer();
          
          // Decompress content if needed
          const decompressedBuffer = await decompressWithWorker(
            Buffer.from(responseBuffer),
            contentEncoding || undefined
          );
          
          // Convert buffer to string with UTF-8 encoding
          const responseText = new TextDecoder('utf-8').decode(decompressedBuffer);
          
          // Log the raw content for debugging
          logger.debug({
            type: 'proxy',
            url,
            contentType: 'application/vnd.apple.mpegurl',
            rawContentStart: responseText.substring(0, 100),
            decompressed: !!contentEncoding,
            decompressedLength: decompressedBuffer.length,
            originalLength: responseBuffer.byteLength
          }, `Raw M3U8 content start for ${url}`);
          
          // Check for #EXTM3U in the content (case insensitive)
          if (!responseText.toUpperCase().includes('#EXTM3U')) {
            logger.warn({
              type: 'proxy',
              url,
              contentLength: responseText.length,
              contentSample: responseText.substring(0, 200)
            }, `Content doesn't appear to be a valid M3U8 playlist (missing #EXTM3U) but has length ${responseText.length}`);
            
            // Just return the content as-is
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            // Don't forward the content-encoding, we've already decompressed
            res.removeHeader('content-encoding');
            recordResponse(requestStartTime, true, requestSize, decompressedBuffer.length);
            return res.send(Buffer.from(decompressedBuffer));
          }
          
          // At this point we have valid M3U8 content
          logger.info({
            type: 'proxy',
            url,
            isValid: true
          }, `Valid M3U8 content found at ${url}`);
          
          // Process the M3U8 content to rewrite URLs
          const processedContent = processM3u8Content(responseText, {
            proxyBaseUrl: ROUTES.PROXY_BASE,
            targetUrl: url,
            urlParamName: 'url',
            preserveQueryParams: true,
          });
          
          // Set explicit content type for M3U8
          res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
          // Don't forward the content-encoding, we've already decompressed
          res.removeHeader('content-encoding');
          
          logger.debug({
            type: 'proxy',
            url,
            status: response.status,
            contentType: 'application/vnd.apple.mpegurl',
            responseTime: Date.now() - startTime,
          }, `Processed M3U8 playlist for ${url}`);
          
          recordResponse(requestStartTime, true, requestSize, processedContent.length);
          return res.send(processedContent);
        } catch (error) {
          logger.error({
            type: 'proxy',
            url,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined
          }, 'Error processing M3U8 content');
          
          // Try to return the original content on error
          try {
            // Get content encoding from headers
            const contentEncoding = response.headers.get('content-encoding');
            const buffer = await response.arrayBuffer();
            
            // Try to decompress content even on error
            const decompressedBuffer = await decompressWithWorker(
              Buffer.from(buffer),
              contentEncoding || undefined
            ).catch(() => Buffer.from(buffer));
            
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            // Don't forward the content-encoding, we've already decompressed
            res.removeHeader('content-encoding');
            res.status(200);
            recordResponse(requestStartTime, true, requestSize, decompressedBuffer.length);
            return res.send(Buffer.from(decompressedBuffer));
          } catch (e) {
            recordResponse(requestStartTime, false, requestSize, 0);
            res.status(500).json({
              error: {
                code: 500,
                message: 'Failed to process M3U8 content',
                url,
                details: error instanceof Error ? error.message : String(error)
              },
              success: false,
              timestamp: new Date().toISOString()
            });
          }
        }
      }
      // Handle WebVTT subtitle files
      else if (contentType?.includes('text/vtt') && response.status === 200) {
        try {
          // Get content as text
          const responseText = await response.text();
          
          // Process VTT content to rewrite image URLs
          const processedContent = processVttContent(responseText, {
            proxyBaseUrl: ROUTES.PROXY_BASE,
            targetUrl: url,
            urlParamName: 'url',
          });
          
          // Set explicit content type for VTT
          res.setHeader('Content-Type', 'text/vtt');
          
          // Don't forward the content-encoding if any
          if (contentEncoding) {
            res.removeHeader('content-encoding');
          }
          
          logger.debug({
            type: 'proxy',
            url,
            status: response.status,
            contentType: 'text/vtt',
            responseTime: Date.now() - startTime,
          }, `Processed VTT subtitle file for ${url}`);
          
          recordResponse(requestStartTime, true, requestSize, processedContent.length);
          return res.send(processedContent);
        } catch (error) {
          logger.error({
            type: 'proxy',
            url,
            error: error instanceof Error ? error.message : String(error),
          }, 'Error processing VTT content');
          
          // Fall back to returning unprocessed content
          // Continue to the general content handling below
        }
      }
      // Handle all other content types using a buffer-based approach
      else if (response.body) {
        try {
          // Get the content as an ArrayBuffer
          const responseBuffer = await response.arrayBuffer();
          
          // Check if this is an obfuscated video segment (fake extension)
          const isObfuscated = isObfuscatedVideoSegment(url, contentType);
          
          // Decompress content if needed (but skip for obfuscated segments)
          const buffer = contentEncoding && !isAudioSegment && !isObfuscated
            ? await decompressWithWorker(
                Buffer.from(responseBuffer),
                contentEncoding
              )
            : Buffer.from(responseBuffer);
          
          // Perform binary analysis to detect actual content type
          const detectedType = determineContentType(buffer, contentType, url);
          
          // Set the appropriate content type
          if (detectedType && !isAudioSegment) {
            res.setHeader('Content-Type', detectedType);
            
            // Log if we're overriding the content type
            if (detectedType !== contentType) {
              logger.info({
                type: 'proxy',
                url,
                originalContentType: contentType || 'none',
                newContentType: detectedType
              }, `Binary analysis: overriding content type for ${url}`);
            }
          } else if (contentType) {
            res.setHeader('Content-Type', contentType);
          } else {
            // Try to determine content type by extension
            const mimeType = getMimeType(url);
            if (mimeType) {
              res.setHeader('Content-Type', mimeType);
            }
          }
          
          // Don't forward content-encoding header if we've decompressed the content
          // For obfuscated segments, keep the original encoding header (they're not actually compressed)
          if (contentEncoding && !isAudioSegment && !isObfuscated) {
            res.removeHeader('content-encoding');
          }
          
          // Set status code
          res.status(response.status);
          
          logger.debug({
            type: 'proxy',
            url,
            status: response.status,
            contentType: res.getHeader('Content-Type'),
            responseTime: Date.now() - startTime,
            size: buffer.byteLength,
            decompressed: !!contentEncoding && !isAudioSegment
          }, `Proxied content for ${url}`);
          
          // Add to cache for successful GET requests
          if (req.method === 'GET' && response.status === 200 && !req.headers.range) {
            // Skip caching for very large responses
            if (buffer.byteLength <= 10 * 1024 * 1024) { // Only cache up to 10MB
              const cacheKey = generateCacheKey(url, req.headers);
              setCacheItem(cacheKey, buffer, buffer.byteLength);
            }
          }
          
          recordResponse(requestStartTime, true, requestSize, buffer.byteLength);
          
          // Return the buffer directly
          return res.send(Buffer.from(buffer));
        } catch (error) {
          logger.error({
            type: 'proxy',
            url,
            error: error instanceof Error ? error.message : String(error),
          }, 'Error processing response content');
          
          recordResponse(requestStartTime, false, requestSize, 0);
          
          return res.status(500).json({
            error: {
              code: 500,
              message: 'Failed to process response content',
              url,
              details: error instanceof Error ? error.message : String(error)
            },
            success: false,
            timestamp: new Date().toISOString()
          });
        }
      } else {
        // For empty responses
        res.status(response.status);
        recordResponse(requestStartTime, true, requestSize, 0);
        return res.end();
      }
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    // Handle proxy errors
    logger.error({
      type: 'proxy',
      url,
      error: error instanceof Error ? error.message : String(error),
    }, 'Proxy request failed');
    
    // Determine appropriate error message and status
    let statusCode = 500;
    let errorMessage = 'Failed to proxy request';
    
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        statusCode = 504;
        errorMessage = `Request timed out after ${PROXY.REQUEST_TIMEOUT}ms`;
      } else {
        errorMessage = error.message || errorMessage;
      }
    }
    
    recordResponse(requestStartTime, false, requestSize, 0);
    
    res.status(statusCode).json({
      error: {
        code: statusCode,
        message: errorMessage,
        url,
      },
      success: false,
      timestamp: new Date().toISOString(),
    });
  }
}

// ==================== IMAGE PROXY ROUTES ====================

/**
 * Image proxy endpoint - handles encoded image URLs
 * Usage: <img src="/image/base64encodedurl" />
 */
router.get('/image/:encodedUrl', async (req: Request, res: Response) => {
  const { encodedUrl } = req.params;
  
  if (!encodedUrl) {
    return res.status(400).json({
      error: {
        code: 400,
        message: 'Missing encoded URL parameter',
      },
      success: false,
      timestamp: new Date().toISOString(),
    });
  }
  
  let imageUrl: string;
  
  try {
    // Decode the URL
    imageUrl = decodeImageUrl(encodedUrl);
  } catch (error) {
    return res.status(400).json({
      error: {
        code: 400,
        message: 'Invalid encoded URL',
        details: error instanceof Error ? error.message : String(error),
      },
      success: false,
      timestamp: new Date().toISOString(),
    });
  }
  
  // Validate the decoded URL
  const validation = validateUrl(imageUrl, {
    maxUrlLength: PROXY.MAX_REQUEST_SIZE,
    allowedDomains: PROXY.ENABLE_DOMAIN_WHITELIST ? PROXY.ALLOWED_DOMAINS : [],
  });
  
  if (!validation.valid) {
    return res.status(400).json({
      error: {
        code: 400,
        message: validation.reason || 'Invalid image URL',
        url: imageUrl,
      },
      success: false,
      timestamp: new Date().toISOString(),
    });
  }
  
  const requestStartTime = recordRequest();
  
  try {
    // Check cache first
    const cacheKey = generateCacheKey(imageUrl, { accept: 'image/*' });
    const cachedItem = getCacheItem(cacheKey);
    
    if (cachedItem) {
      recordCacheHit();
      
      // Determine content type from cached data
      const contentType = determineContentType(cachedItem.data, null, imageUrl);
      
      // Set response headers
      res.setHeader('Content-Type', contentType || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('X-Cache', 'HIT');
      
      // Add CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
      
      recordResponse(requestStartTime, true, 0, cachedItem.data.length);
      return res.send(cachedItem.data);
    }
    
    recordCacheMiss();
    
    // Set up request headers
    const headers: Record<string, string> = {
      'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    };
    
    // Parse target URL and set host header
    const targetUrl = new URL(imageUrl);
    headers['host'] = targetUrl.host;
    
    // Apply domain-specific headers
    const domainHeaders = generateHeadersForUrl(targetUrl);
    Object.assign(headers, domainHeaders);
    
    // Fetch the image
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), PROXY.REQUEST_TIMEOUT);
    
    try {
      const response = await fetch(imageUrl, {
        method: 'GET',
        headers,
        signal: abortController.signal,
        agent: imageUrl.startsWith('https') ? httpsAgent : undefined,
      });
      
      clearTimeout(timeoutId);
      
      // Handle error responses
      if (response.status >= 400) {
        logger.warn({
          type: 'image-proxy',
          url: imageUrl,
          status: response.status,
          statusText: response.statusText,
        }, `Image proxy received error status: ${response.status}`);
        
        recordResponse(requestStartTime, false, 0, 0);
        
        return res.status(response.status).json({
          error: {
            code: response.status,
            message: `Failed to fetch image: ${response.statusText}`,
            url: imageUrl,
          },
          success: false,
          timestamp: new Date().toISOString(),
        });
      }
      
      // Get content type and encoding
      const contentType = response.headers.get('content-type');
      const contentEncoding = response.headers.get('content-encoding');
      
      // Verify it's an image
      if (!isImageUrl(imageUrl, contentType)) {
        logger.warn({
          type: 'image-proxy',
          url: imageUrl,
          contentType,
        }, 'URL does not appear to be an image');
      }
      
      // Get the image data
      const arrayBuffer = await response.arrayBuffer();
      let buffer = Buffer.from(arrayBuffer);
      
      // Decompress if needed
      if (contentEncoding) {
        const decompressedBuffer = await decompressWithWorker(buffer, contentEncoding);
        buffer = Buffer.from(decompressedBuffer);
      }
      
      // Determine actual content type from binary data
      const detectedType = determineContentType(buffer, contentType, imageUrl);
      
      // Set response headers
      res.setHeader('Content-Type', detectedType || contentType || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('X-Cache', 'MISS');
      
      // Add comprehensive CORS headers (following Rust proxy pattern)
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS, HEAD');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Origin, Accept, Accept-Encoding, Accept-Language, Cache-Control, Pragma');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Type, Cache-Control, ETag, Last-Modified');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Vary', 'Origin');
      
      // Cache the image (up to 10MB)
      if (buffer.length <= 10 * 1024 * 1024) {
        setCacheItem(cacheKey, buffer, buffer.length);
      }
      
      logger.debug({
        type: 'image-proxy',
        url: imageUrl,
        contentType: detectedType || contentType,
        size: buffer.length,
      }, `Successfully proxied image`);
      
      recordResponse(requestStartTime, true, 0, buffer.length);
      return res.send(buffer);
      
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    logger.error({
      type: 'image-proxy',
      url: imageUrl,
      error: error instanceof Error ? error.message : String(error),
    }, 'Image proxy request failed');
    
    let statusCode = 500;
    let errorMessage = 'Failed to proxy image';
    
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        statusCode = 504;
        errorMessage = `Request timed out after ${PROXY.REQUEST_TIMEOUT}ms`;
      } else {
        errorMessage = error.message || errorMessage;
      }
    }
    
    recordResponse(requestStartTime, false, 0, 0);
    
    return res.status(statusCode).json({
      error: {
        code: statusCode,
        message: errorMessage,
        url: imageUrl,
      },
      success: false,
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * Image encode endpoint - helper to generate encoded URLs
 * Usage: GET /image/encode?url=https://example.com/image.jpg
 */
router.get('/image/encode', (req: Request, res: Response) => {
  const imageUrl = req.query.url as string;
  
  if (!imageUrl) {
    return res.status(400).json({
      error: {
        code: 400,
        message: 'Missing URL parameter',
        usage: 'Use ?url=https://example.com/image.jpg',
      },
      success: false,
      timestamp: new Date().toISOString(),
    });
  }
  
  // Validate URL
  const validation = validateUrl(imageUrl, {
    maxUrlLength: PROXY.MAX_REQUEST_SIZE,
    allowedDomains: PROXY.ENABLE_DOMAIN_WHITELIST ? PROXY.ALLOWED_DOMAINS : [],
  });
  
  if (!validation.valid) {
    return res.status(400).json({
      error: {
        code: 400,
        message: validation.reason || 'Invalid URL',
        url: imageUrl,
      },
      success: false,
      timestamp: new Date().toISOString(),
    });
  }
  
  try {
    const encodedUrl = encodeImageUrl(imageUrl);
    const proxiedUrl = `${ROUTES.IMAGE_PROXY_BASE}/${encodedUrl}`;
    
    // Get the base URL from request
    const protocol = req.protocol;
    const host = req.get('host');
    const fullProxiedUrl = `${protocol}://${host}${proxiedUrl}`;
    
    return res.json({
      success: true,
      data: {
        originalUrl: imageUrl,
        encodedUrl,
        proxiedUrl,
        fullProxiedUrl,
        htmlExample: `<img src="${proxiedUrl}" alt="Proxied image" />`,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      error: {
        code: 500,
        message: 'Failed to encode URL',
        details: error instanceof Error ? error.message : String(error),
      },
      success: false,
      timestamp: new Date().toISOString(),
    });
  }
});

// ==================== STATUS & MONITORING ROUTES ====================

// Status endpoint
router.get('/status', (req, res) => {
  const uptime = process.uptime();
  const memory = process.memoryUsage();
  
  return res.json({
    status: 'ok',
    version: process.env.npm_package_version || '0.2.0',
    uptime,
    timestamp: new Date().toISOString(),
    environment: SERVER.NODE_ENV,
    memory: {
      rss: Math.round(memory.rss / 1024 / 1024 * 100) / 100,
      heapTotal: Math.round(memory.heapTotal / 1024 / 1024 * 100) / 100,
      heapUsed: Math.round(memory.heapUsed / 1024 / 1024 * 100) / 100,
      external: Math.round(memory.external / 1024 / 1024 * 100) / 100,
    },
  });
});

// Cache endpoints
router.get('/cache/stats', (req, res) => {
  res.json({
    status: 'ok',
    data: getCacheStats(),
    timestamp: new Date().toISOString(),
  });
});

router.post('/cache/clear', (req, res) => {
  clearCache();
  res.json({
    status: 'ok',
    message: 'Cache cleared successfully',
    timestamp: new Date().toISOString(),
  });
});

// Worker stats endpoint
router.get('/workers/stats', (req, res) => {
  res.json({
    status: 'ok',
    data: getWorkerStats(),
    timestamp: new Date().toISOString(),
  });
});

// Performance metrics endpoints
router.get('/metrics', (req, res) => {
  res.json({
    status: 'ok',
    data: getPerformanceMetrics(),
    timestamp: new Date().toISOString(),
  });
});

router.post('/metrics/reset', (req, res) => {
  resetMetrics();
  res.json({
    status: 'ok',
    message: 'Performance metrics reset successfully',
    timestamp: new Date().toISOString(),
  });
});

// Main proxy route with URL as query parameter
router.all('/', validateUrlParam, proxyRequest);

// Proxy route with base64 encoded URL - MUST come before catch-all route
router.all('/base64/:encodedUrl', validateUrlParam, proxyRequest);

// Proxy route with URL as path parameter - catch-all route (must be last)
router.all('/:url(*)', validateUrlParam, proxyRequest);

export default router;