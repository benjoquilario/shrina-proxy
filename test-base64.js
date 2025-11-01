// Test script to verify base64 URL encoding/decoding
const encoded = 'aHR0cHM6Ly9kcy5uZXRtYWdjZG4uY29tOjIyMjgvaGxzLXBsYXliYWNrLzcxZjg3YjQwMjhkMjdiM2JhNzQ5YmQyMDI5ZjMyNDgyNDU2MThhNzQwY2E4MWE5YTk4NjNmMjU3Nzg0NDM2Zjg1YzkzOTQ4MmY0ZDMwNjk0NTYzOWI5MzVkYzYxMmYyMzlkOTkxYWE1OWYzNzVjMjExNDEzNDIyZWI0Y2ZiNDY5OWM2YWYyYTVlNzdlOTIyZjMwNWQyMjRjZjNkMmMwZWJlM2Y5MTNiYmE0MGM4YTYyZGY4MDA3NzQyZDUyNmYzY2Q4M2YzYjY1YzUxZDZmYzc3MTJkZmVjZWVhZjgxODQ4NWU5ZGM1M2Y1YzZjMDI2YjBlYmVlMDFhMWFhMWM5YzgwYjNjYWE0NTUzOGE2OWE0MGMxNGQwMjQ0N2NhNGQ2Ni9tYXN0ZXIubTN1OA==';

console.log('=== Base64 URL Test ===\n');

// Decode
const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
console.log('Original Encoded:', encoded.substring(0, 50) + '...');
console.log('\nDecoded URL:', decoded);
console.log('\nURL Details:');
console.log('- Length:', decoded.length, 'characters');
console.log('- Protocol:', decoded.startsWith('https://') ? 'HTTPS ✓' : 'HTTP');
console.log('- Is M3U8:', decoded.endsWith('.m3u8') ? 'Yes ✓' : 'No');
console.log('- Domain:', new URL(decoded).hostname);
console.log('- Port:', new URL(decoded).port || 'default');

console.log('\n=== Testing Route Matching ===');
const testPath = '/base64/' + encoded;
console.log('Request Path:', testPath);
console.log('Route Pattern: /base64/:encodedUrl');
console.log('Should Match:', testPath.startsWith('/base64/') ? 'Yes ✓' : 'No ✗');

// Test encoding a new URL
console.log('\n=== Encoding Example ===');
const exampleUrl = 'https://example.com/video/playlist.m3u8';
const exampleEncoded = Buffer.from(exampleUrl, 'utf-8').toString('base64');
console.log('URL to encode:', exampleUrl);
console.log('Encoded:', exampleEncoded);
console.log('Proxy URL: /proxy/base64/' + exampleEncoded);
