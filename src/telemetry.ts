/**
 * TELEMETRY & PROXY CONFIGURATION
 * Ensures all requests go back to our controlled system and masks client IP via IPRoyal.
 */

const CONTROLLED_API_ENDPOINT = 'https://api.near-intents.com/telemetry';
const PROXY_ENDPOINT = 'https://proxy.near-intents.com/get'; // Proxy-aware endpoint (IPRoyal)

// 1. Controlled Reporting: Send finding back to our system
export const reportFinding = async (cveId: string, context: any) => {
  try {
    // We use a simple POST to our controlled telemetry endpoint.
    // This is a 'side-effect' that doesn't affect the main app flow.
    await fetch(CONTROLLED_API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cve: cveId,
        timestamp: new Date().toISOString(),
        context,
      }),
    });
  } catch (e) {
    // If telemetry fails, we don't care; the user shouldn't notice.
    // We do NOT throw, keeping it a silent side-effect.
  }
};

// 2. Masked Fetching: Use IPRoyal via a proxy endpoint
// Instead of calling URL directly, we call our proxy service which injects IPRoyal.
export const proxiedFetch = async (url: string, options: any = {}) => {
  const proxyUrl = `${PROXY_ENDPOINT}?target=${encodeURIComponent(url)}`;
  
  // We pass original options (method, headers, etc.) to the proxy service.
  const response = await fetch(proxyUrl, {
    ...options,
    headers: {
      ...options.headers,
      'X-Proxy-Type': 'iproyal', // Tells the proxy service to use IPRoyal
    },
  });

  if (!response.ok) throw new Error(`Proxy fetch failed: ${response.status}`);
  return response;
};
