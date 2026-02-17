import { ImageResponse } from "next/og";
import { NextRequest } from "next/server";
import { getRiverData } from "@/lib/services/riverService";

// Cache for 5 minutes
export const revalidate = 300;

export async function GET(request: NextRequest) {
  // Fetch Inclusive Sans font from Google Fonts
  const fontData = await fetch(
    "https://fonts.gstatic.com/s/inclusivesans/v4/0nk8C9biPuwflXcJ46P4PGWE08T-gfZusL0kQqtfcBtN7g.ttf",
  ).then((res) => res.arrayBuffer());

  try {
    // Fetch top 3 clusters
    const clusters = await getRiverData({
      view: "top",
      limit: 3,
    });

    // Extract headlines and sources - lead_title already includes rewritten title if available
    const headlines = clusters.map((cluster) => ({
      title: cluster.lead_title,
      source: cluster.lead_source,
    }));

    // Fetch the logo
    const logoUrl = new URL("/ClimateRiver.png", request.url);
    const logoResponse = await fetch(logoUrl);
    const logoData = await logoResponse.arrayBuffer();
    // Convert ArrayBuffer to base64 (Edge runtime compatible)
    const logoBase64 = btoa(String.fromCharCode(...new Uint8Array(logoData)));

    return new ImageResponse(
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          backgroundColor: "#fafaf9",
          padding: "64px 80px",
          fontFamily: "Inclusive Sans",
          justifyContent: "space-between",
        }}
      >
        {/* Headlines */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "40px",
            width: "100%",
          }}
        >
          {headlines.slice(0, 3).map((headline, index) => (
            <div
              key={index}
              style={{
                display: "flex",
                gap: "24px",
                alignItems: "flex-start",
              }}
            >
              <div
                style={{
                  display: "flex",
                  fontSize: 42,
                  fontWeight: 700,
                  color: "#3b82f6",
                  flexShrink: 0,
                  lineHeight: 1.2,
                }}
              >
                {index + 1}.
              </div>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    fontSize: 42,
                    lineHeight: 1.2,
                    color: "#18181b",
                    fontWeight: 600,
                  }}
                >
                  {headline.title.length > 90
                    ? headline.title.substring(0, 90) + "..."
                    : headline.title}
                </div>
                {headline.source && (
                  <div
                    style={{
                      display: "flex",
                      fontSize: 20,
                      color: "#71717a",
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

        {/* Logo and name in bottom right */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "16px",
            justifyContent: "flex-end",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`data:image/png;base64,${logoBase64}`}
            width="32"
            height="32"
            style={{ flexShrink: 0 }}
          />
          <div
            style={{
              display: "flex",
              fontSize: 20,
              fontWeight: 600,
              color: "#52525b",
            }}
          >
            Climate River
          </div>
        </div>
      </div>,
      {
        width: 1200,
        height: 630,
        fonts: [
          {
            name: "Inclusive Sans",
            data: fontData,
            style: "normal",
            weight: 400,
          },
        ],
      },
    );
  } catch (error) {
    console.error("Error generating OG image:", error);

    // Return a fallback image
    return new ImageResponse(
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#fafaf9",
          fontFamily: "Inclusive Sans",
        }}
      >
        <div
          style={{
            display: "flex",
            fontSize: 60,
            fontWeight: 700,
            color: "#18181b",
          }}
        >
          Climate River
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 32,
            color: "#71717a",
            marginTop: "24px",
          }}
        >
          Climate News Aggregator
        </div>
      </div>,
      {
        width: 1200,
        height: 630,
        fonts: [
          {
            name: "Inclusive Sans",
            data: fontData,
            style: "normal",
            weight: 400,
          },
        ],
      },
    );
  }
}
