/**
 * Domain-specific header templates for various streaming services
 * This allows for targeted anti-hotlinking bypass based on the domain
 * 
 * Converted from Rust implementation to TypeScript
 */

import { URL } from 'url';

/**
 * Default headers used by most templates
 */
const DEFAULT_HEADERS: Record<string, string> = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:137.0) Gecko/20100101 Firefox/137.0',
  'accept': '*/*',
  'accept-language': 'en-US,en;q=0.5',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'cross-site',
};

/**
 * Domain group configuration
 */
interface DomainGroup {
  patterns: RegExp[];
  origin: string;
  referer: string;
  customHeaders?: Record<string, string>;
}

/**
 * Domain groups with patterns and corresponding headers
 */
const DOMAIN_GROUPS: DomainGroup[] = [
  {
    patterns: [
      /\.padorupado\.ru$/i,
      /\.kwikie\.ru$/i,
    ],
    origin: 'https://kwik.si',
    referer: 'https://kwik.si/',
    customHeaders: {
      'cache-control': 'no-cache',
      'pragma': 'no-cache',
    },
  },
  {
    patterns: [
      /\.streamtape\.to$/i,
    ],
    origin: 'https://streamtape.to',
    referer: 'https://streamtape.to/',
  },
  {
    patterns: [
      /vidcache\.net$/i,
      /(?:^|\.)animegg\.org$/i,
    ],
    origin: 'https://www.animegg.org',
    referer: 'https://www.animegg.org/',
  },
  {
    patterns: [
      /krussdomi\.com$/i,
      /revolutionizingtheweb\.xyz$/i,
      /nextgentechnologytrends\.xyz$/i,
      /smartinvestmentstrategies\.xyz$/i,
      /creativedesignstudioxyz\.xyz$/i,
      /breakingdigitalboundaries\.xyz$/i,
      /ultimatetechinnovation\.xyz$/i,
    ],
    origin: 'https://krussdomi.com',
    referer: 'https://krussdomi.com/',
  },
  {
    patterns: [
      /\.akamaized\.net$/i,
    ],
    origin: 'https://players.akamai.com',
    referer: 'https://players.akamai.com/',
  },
  {
    patterns: [
      /(?:^|\.)shadowlandschronicles\./i,
      /digitalshinecollective\.xyz$/i,
      /thrivequesthub\.xyz$/i,
      /novaedgelabs\.xyz$/i,
    ],
    origin: 'https://cloudnestra.com',
    referer: 'https://cloudnestra.com/',
  },
  {
    patterns: [
      /(?:^|\.)viddsn\./i,
      /\.anilike\.cyou$/i,
    ],
    origin: 'https://vidwish.live/',
    referer: 'https://vidwish.live/',
  },
  {
    patterns: [
      /(?:^|\.)dotstream\./i,
      /(?:^|\.)playcloud1\./i,
    ],
    origin: 'https://megaplay.buzz/',
    referer: 'https://megaplay.buzz/',
  },
  {
    patterns: [
      /\.cloudfront\.net$/i,
    ],
    origin: 'https://d2zihajmogu5jn.cloudfront.net',
    referer: 'https://d2zihajmogu5jn.cloudfront.net/',
  },
  {
    patterns: [
      /\.ttvnw\.net$/i,
    ],
    origin: 'https://www.twitch.tv',
    referer: 'https://www.twitch.tv/',
  },
  {
    patterns: [
      /\.xx\.fbcdn\.net$/i,
    ],
    origin: 'https://www.facebook.com',
    referer: 'https://www.facebook.com/',
  },
  {
    patterns: [
      /\.anih1\.top$/i,
      /\.xyk3\.top$/i,
    ],
    origin: 'https://ee.anih1.top',
    referer: 'https://ee.anih1.top/',
  },
  {
    patterns: [
      /\.premilkyway\.com$/i,
    ],
    origin: 'https://uqloads.xyz',
    referer: 'https://uqloads.xyz/',
  },
  {
    patterns: [
      /\.streamcdn\.com$/i,
    ],
    origin: 'https://anime.uniquestream.net',
    referer: 'https://anime.uniquestream.net/',
  },
  {
    patterns: [
      /\.raffaellocdn\.net$/i,
      /\.feetcdn\.com$/i,
      /clearskydrift45\.site$/i,
    ],
    origin: 'https://kerolaunochan.online',
    referer: 'https://kerolaunochan.online/',
  },
  {
    patterns: [
      /dewbreeze84\.online$/i,
      /cloudydrift38\.site$/i,
      /sunshinerays93\.live$/i,
      /clearbluesky72\.wiki$/i,
      /breezygale56\.online$/i,
      /frostbite27\.pro$/i,
      /frostywinds57\.live$/i,
      /icyhailstorm64\.wiki$/i,
      /icyhailstorm29\.online$/i,
      /windflash93\.xyz$/i,
      /stormdrift27\.site$/i,
      /tempestcloud61\.wiki$/i,
      /sunburst66\.pro$/i,
      /douvid\.xyz$/i,
    ],
    origin: 'https://megacloud.blog',
    referer: 'https://megacloud.blog/',
    customHeaders: {
      'cache-control': 'no-cache',
      'pragma': 'no-cache',
    },
  },
  {
    patterns: [
      /\.echovideo\.to$/i,
    ],
    origin: 'https://aniwave.se',
    referer: 'https://aniwave.se/',
  },
  {
    patterns: [
      /\.vid-cdn\.xyz$/i,
    ],
    origin: 'https://anizone.to/',
    referer: 'https://anizone.to/',
  },
  {
    patterns: [
      /\.1stkmgv1\.com$/i,
    ],
    origin: 'https://animeyy.com',
    referer: 'https://animeyy.com/',
  },
  {
    patterns: [
      /lightningspark77\.pro$/i,
      /thunderwave48\.xyz$/i,
      /stormwatch95\.site$/i,
      /windyrays29\.online$/i,
      /thunderstrike77\.online$/i,
      /lightningflash39\.live$/i,
      /cloudburst82\.xyz$/i,
      /drizzleshower19\.site$/i,
      /rainstorm92\.xyz$/i,
    ],
    origin: 'https://megacloud.club',
    referer: 'https://megacloud.club/',
  },
  {
    patterns: [
      /cloudburst99\.xyz$/i,
      /frostywinds73\.pro$/i,
      /stormwatch39\.live$/i,
      /sunnybreeze16\.live$/i,
      /mistydawn62\.pro$/i,
      /lightningbolt21\.live$/i,
      /gentlebreeze85\.xyz$/i,
    ],
    origin: 'https://videostr.net',
    referer: 'https://videostr.net/',
  },
  {
    patterns: [
      /vmeas\.cloud$/i,
    ],
    origin: 'https://vidmoly.to',
    referer: 'https://vidmoly.to/',
  },
  {
    patterns: [
      /nextwaveinitiative\.xyz$/i,
    ],
    origin: 'https://edgedeliverynetwork.org',
    referer: 'https://edgedeliverynetwork.org/',
  },
  {
    patterns: [
      /lightningbolts\.ru$/i,
      /lightningbolt\.site$/i,
      /vyebzzqlojvrl\.top$/i,
    ],
    origin: 'https://vidsrc.cc',
    referer: 'https://vidsrc.cc/',
  },
  {
    patterns: [
      /vidlvod\.store$/i,
    ],
    origin: 'https://vidlink.pro',
    referer: 'https://vidlink.pro/',
  },
  {
    patterns: [
      /sunnybreeze16\.live$/i,
    ],
    origin: 'https://megacloud.store',
    referer: 'https://megacloud.store/',
  },
  {
    patterns: [
      /heatwave90\.pro$/i,
      /humidmist27\.wiki$/i,
      /frozenbreeze65\.live$/i,
      /drizzlerain73\.online$/i,
      /sunrays81\.xyz$/i,
    ],
    origin: 'https://kerolaunochan.live',
    referer: 'https://kerolaunochan.live/',
  },
  {
    patterns: [
      /\.vkcdn5\.com$/i,
    ],
    origin: 'https://vkspeed.com',
    referer: 'https://vkspeed.com/',
  },
  {
    patterns: [
      /embed\.su$/i,
      /usbigcdn\.cc$/i,
      /\.congacdn\.cc$/i,
    ],
    origin: 'https://embed.su',
    referer: 'https://embed.su/',
  },
];

/**
 * Generate headers for a URL with optional custom origin
 * @param url The URL to generate headers for
 * @param customOrigin Optional custom origin to override template origin
 * @returns Headers map for the request
 */
export function generateHeadersForUrl(url: URL, customOrigin?: string): Record<string, string> {
  // Start with default headers
  const headers: Record<string, string> = { ...DEFAULT_HEADERS };

  // If custom origin is provided, use it
  if (customOrigin) {
    headers['origin'] = customOrigin;
    
    // Set referer based on custom origin
    const referer = customOrigin.endsWith('/') ? customOrigin : `${customOrigin}/`;
    headers['referer'] = referer;
  } else {
    // Find matching domain template and use its headers
    const hostname = url.hostname;
    const matchedGroup = DOMAIN_GROUPS.find(group => 
      group.patterns.some(pattern => pattern.test(hostname))
    );

    if (matchedGroup) {
      // Add origin and referer from template
      headers['origin'] = matchedGroup.origin;
      headers['referer'] = matchedGroup.referer;

      // Add custom headers for this domain group if they exist
      if (matchedGroup.customHeaders) {
        Object.assign(headers, matchedGroup.customHeaders);
      }
    } else {
      // Fallback: use the URL's own origin and referer when no template is found
      const scheme = url.protocol.replace(':', '');
      const host = url.host;
      const origin = `${scheme}://${host}`;
      
      headers['origin'] = origin;
      headers['referer'] = `${origin}/`;
    }
  }

  return headers;
}

/**
 * Find the domain group that matches the given URL
 * @param url The URL to match
 * @returns The matching domain group or undefined
 */
export function findDomainGroup(url: URL): DomainGroup | undefined {
  const hostname = url.hostname;
  return DOMAIN_GROUPS.find(group => 
    group.patterns.some(pattern => pattern.test(hostname))
  );
}

/**
 * Check if a URL matches any domain template
 * @param url The URL to check
 * @returns True if the URL matches a template
 */
export function hasTemplate(url: URL): boolean {
  return findDomainGroup(url) !== undefined;
}

/**
 * Get all domain groups (for debugging/testing)
 * @returns All configured domain groups
 */
export function getDomainGroups(): DomainGroup[] {
  return DOMAIN_GROUPS;
}

export default {
  generateHeadersForUrl,
  findDomainGroup,
  hasTemplate,
  getDomainGroups,
};
