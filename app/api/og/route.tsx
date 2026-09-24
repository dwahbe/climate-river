import { ImageResponse } from "next/og";
import { NextRequest } from "next/server";
import { getRiverData } from "@/lib/services/riverService";

// Cache for 5 minutes
export const revalidate = 300;

// Same date format and time zone as the site's LocalTime component
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "America/Los_Angeles",
});

// Static Inclusive Sans instances (satori can't read variable fonts), one per weight used below
const INCLUSIVE_SANS = [
  {
    weight: 400,
    url: "https://fonts.gstatic.com/s/inclusivesans/v5/0nk8C9biPuwflXcJ46P4PGWE08T-gfZusL0kQqtfcBtN7g.ttf",
  },
  {
    weight: 600,
    url: "https://fonts.gstatic.com/s/inclusivesans/v5/0nk8C9biPuwflXcJ46P4PGWE08T-gfZusL0kQqtfrhxN7g.ttf",
  },
  {
    weight: 700,
    url: "https://fonts.gstatic.com/s/inclusivesans/v5/0nk8C9biPuwflXcJ46P4PGWE08T-gfZusL0kQqtflxxN7g.ttf",
  },
] as const;

export async function GET(request: NextRequest) {
  // Fetch Inclusive Sans fonts from Google Fonts
  const fonts = await Promise.all(
    INCLUSIVE_SANS.map(async ({ weight, url }) => ({
      name: "Inclusive Sans",
      data: await fetch(url).then((res) => res.arrayBuffer()),
      style: "normal" as const,
      weight,
    })),
  );

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
          padding: "56px 80px",
          fontFamily: "Inclusive Sans",
          color: "#18181b",
        }}
      >
        {/* Brand top-left, section label top-right */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`data:image/png;base64,${logoBase64}`}
              width={40}
              height={40}
            />
            <div
              style={{
                display: "flex",
                fontSize: 30,
                fontWeight: 600,
                letterSpacing: "-0.01em",
              }}
            >
              Climate River
            </div>
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 22,
              fontWeight: 600,
              color: "#71717a",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            {`Top stories · ${dateFormatter.format(new Date())}`}
          </div>
        </div>

        {/* Headlines, vertically centered in the remaining space */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            flexGrow: 1,
            gap: "22px",
            marginTop: "28px",
          }}
        >
          {headlines.slice(0, 3).map((headline, index) => (
            <div
              key={index}
              style={{ display: "flex", gap: "20px", alignItems: "flex-start" }}
            >
              <div
                style={{
                  display: "flex",
                  width: "44px",
                  flexShrink: 0,
                  fontSize: 42,
                  fontWeight: 700,
                  lineHeight: 1.15,
                  color: "#2563eb",
                }}
              >
                {index + 1}
              </div>
              {/* Satori defaults flexShrink to 0; without it the column overflows the right padding */}
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  flexGrow: 1,
                  flexShrink: 1,
                  minWidth: 0,
                  gap: "6px",
                }}
              >
                <div
                  style={{
                    display: "block",
                    fontSize: 42,
                    fontWeight: 600,
                    lineHeight: 1.15,
                    letterSpacing: "-0.02em",
                    lineClamp: 2,
                    wordBreak: "break-word",
                  }}
                >
                  {headline.title}
                </div>
                {headline.source && (
                  <div
                    style={{
                      display: "block",
                      fontSize: 26,
                      color: "#52525b",
                      lineClamp: 1,
                    }}
                  >
                    {headline.source}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>,
      {
        width: 1200,
        height: 630,
        fonts,
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
        fonts,
      },
    );
  }
}
