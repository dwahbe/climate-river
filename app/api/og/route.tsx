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

    // Extract headlines - lead_title already includes rewritten title if available
    const headlines = clusters.map((cluster) => cluster.lead_title)

    return new ImageResponse(
      (
        <div
          style={{
            height: '100%',
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            backgroundColor: '#fafaf9',
            padding: '60px 80px',
            fontFamily: 'system-ui, sans-serif',
          }}
        >
          {/* Header */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
            }}
          >
            <div
              style={{
                display: 'flex',
                fontSize: 48,
                fontWeight: 700,
                color: '#18181b',
                letterSpacing: '-0.02em',
              }}
            >
              Climate River
            </div>
            <div
              style={{
                display: 'flex',
                fontSize: 24,
                color: '#71717a',
              }}
            >
              Top climate news right now
            </div>
          </div>

          {/* Headlines */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '28px',
              width: '100%',
              marginTop: '40px',
            }}
          >
            {headlines.slice(0, 3).map((headline, index) => (
              <div
                key={index}
                style={{
                  display: 'flex',
                  gap: '20px',
                  alignItems: 'flex-start',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    fontSize: 28,
                    fontWeight: 700,
                    color: '#3b82f6',
                    flexShrink: 0,
                    lineHeight: 1.3,
                  }}
                >
                  {index + 1}.
                </div>
                <div
                  style={{
                    display: 'flex',
                    fontSize: 28,
                    lineHeight: 1.3,
                    color: '#18181b',
                    fontWeight: 500,
                  }}
                >
                  {headline.length > 120
                    ? headline.substring(0, 120) + '...'
                    : headline}
                </div>
              </div>
            ))}
          </div>

          {/* Footer */}
          <div
            style={{
              display: 'flex',
              fontSize: 20,
              color: '#a1a1aa',
              marginTop: '40px',
            }}
          >
            climateriver.org
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
              marginTop: '20px',
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
