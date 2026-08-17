/*
 * Cloudflare Worker that mints short-lived TURN credentials for the OpenBot
 * controller and the robot.
 *
 * It exists so the Cloudflare TURN API token never reaches the browser: the web
 * controller is a static bundle, so anything compiled into it is public. This
 * Worker holds the token and hands out credentials that expire.
 *
 * Deploy:
 *   wrangler deploy
 *   wrangler secret put TURN_KEY_ID
 *   wrangler secret put TURN_KEY_API_TOKEN
 *
 * Then point VITE_PUBLIC_ICE_SERVERS_URL at the deployed URL.
 */

// How long minted credentials stay valid. Comfortably longer than a driving
// session, short enough that a leaked credential is not much use.
const CREDENTIAL_TTL_SECONDS = 12 * 60 * 60

const corsHeaders = (origin) => ({
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
})

export default {
    async fetch (request, env) {
        // Restrict browsers to the deployed controller if ALLOWED_ORIGIN is set
        // (comma separated), so random sites cannot burn your TURN bandwidth.
        // Requests with no Origin header are allowed through: the robot is a
        // native Android client and never sends one, and blocking it would leave
        // the robot without relay candidates.
        const origin = request.headers.get('Origin')
        const allowed = (env.ALLOWED_ORIGIN || '').split(',').map((value) => value.trim()).filter(Boolean)
        if (allowed.length && origin && !allowed.includes(origin)) {
            return new Response('Forbidden', {status: 403})
        }

        if (request.method === 'OPTIONS') {
            return new Response(null, {status: 204, headers: corsHeaders(origin)})
        }

        if (request.method !== 'GET') {
            return new Response('Method not allowed', {status: 405})
        }

        const response = await fetch(
            `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ttl: CREDENTIAL_TTL_SECONDS})
            }
        )

        if (!response.ok) {
            const detail = await response.text()
            console.error('TURN credential request failed:', response.status, detail)
            return new Response(JSON.stringify({error: 'Could not mint TURN credentials'}), {
                status: 502,
                headers: {...corsHeaders(origin), 'Content-Type': 'application/json'}
            })
        }

        const body = await response.json()

        return new Response(JSON.stringify(body), {
            headers: {
                ...corsHeaders(origin),
                'Content-Type': 'application/json',
                // credentials are per-session; never let a proxy hand out a stale one
                'Cache-Control': 'no-store'
            }
        })
    }
}
