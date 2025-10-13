import { ImageResponse } from 'next/og'
import { NextRequest } from 'next/server'
import { getRiverData } from '@/lib/services/riverService'

export const runtime = 'edge'

// Cache for 5 minutes
export const revalidate = 300

export async function GET(request: NextRequest) {
  try {
    // Fetch top 3 clusters
    const clusters = await getRiverData({
      view: 'top',
      limit: 3,
    })

    // Extract headlines and sources - lead_title already includes rewritten title if available
    const headlines = clusters.map((cluster) => ({
      title: cluster.lead_title,
      source: cluster.lead_source,
    }))

    // Fetch the logo
    const logoUrl = new URL('/ClimateRiver.png', request.url)
    const logoResponse = await fetch(logoUrl)
    const logoData = await logoResponse.arrayBuffer()
    const logoBase64 = Buffer.from(logoData).toString('base64')

    return new ImageResponse(
      (
        <div
          style={{
            height: '100%',
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: '#fafaf9',
            padding: '64px 80px',
            fontFamily: 'system-ui, sans-serif',
          }}
        >
          {/* Small header with logo and name */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '16px',
              marginBottom: '32px',
            }}
          >
            <img
              src={`data:image/png;base64,${logoBase64}`}
              width="32"
              height="32"
              style={{ flexShrink: 0 }}
            />
            <div
              style={{
                display: 'flex',
                fontSize: 20,
                fontWeight: 600,
                color: '#52525b',
              }}
            >
              Climate River
            </div>
          </div>

          {/* Headlines */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '40px',
              width: '100%',
            }}
          >
            {headlines.slice(0, 3).map((headline, index) => (
              <div
                key={index}
                style={{
                  display: 'flex',
                  gap: '24px',
                  alignItems: 'flex-start',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    fontSize: 42,
                    fontWeight: 700,
                    color: '#3b82f6',
                    flexShrink: 0,
                    lineHeight: 1.2,
                  }}
                >
                  {index + 1}.
                </div>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      fontSize: 42,
                      lineHeight: 1.2,
                      color: '#18181b',
                      fontWeight: 600,
                    }}
                  >
                    {headline.title.length > 100
                      ? headline.title.substring(0, 100) + '...'
                      : headline.title}
                  </div>
                  {headline.source && (
                    <div
                      style={{
                        display: 'flex',
                        fontSize: 20,
                        color: '#71717a',
                        fontWeight: 400,
                      }}
                    >
                      {headline.source}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ),
      {
        width: 1200,
        height: 630,
      }
    )
  } catch (error) {
    console.error('Error generating OG image:', error)
    // Return a fallback image
    return new ImageResponse(
      (
        <div
          style={{
            height: '100%',
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: '#fafaf9',
            fontFamily: 'system-ui, sans-serif',
          }}
        >
          <div
            style={{
              display: 'flex',
              fontSize: 60,
              fontWeight: 700,
              color: '#18181b',
            }}
          >
            Climate River
          </div>
          <div
            style={{
              display: 'flex',
              fontSize: 32,
              color: '#71717a',
              marginTop: '24px',
            }}
          >
            Climate News Aggregator
          </div>
        </div>
      ),
      {
        width: 1200,
        height: 630,
      }
    )
  }
}
