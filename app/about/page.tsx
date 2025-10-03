// app/about/page.tsx
import {
  Landmark,
  Megaphone,
  Factory,
  AlertTriangle,
  Zap,
  Microscope,
} from "lucide-react";

export const dynamic = "force-static";

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 pt-2 sm:pt-2.5 pb-8 content">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">About</h1>
        <div className="flex items-center gap-3">
          {/* THE ONE - Six colored arcs forming a perfect sphere */}
          {/* <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 100 100"
            className="w-6 h-6"
          >
            <defs>
              <linearGradient id="grad1" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop
                  offset="0%"
                  style={{ stopColor: '#3B82F6', stopOpacity: 1 }}
                />
                <stop
                  offset="20%"
                  style={{ stopColor: '#EC4899', stopOpacity: 1 }}
                />
                <stop
                  offset="40%"
                  style={{ stopColor: '#06B6D4', stopOpacity: 1 }}
                />
                <stop
                  offset="60%"
                  style={{ stopColor: '#EF4444', stopOpacity: 1 }}
                />
                <stop
                  offset="80%"
                  style={{ stopColor: '#10B981', stopOpacity: 1 }}
                />
                <stop
                  offset="100%"
                  style={{ stopColor: '#8B5CF6', stopOpacity: 1 }}
                />
              </linearGradient>
            </defs>
            <path
              d="M 50 15 Q 65 20, 75 35 Q 80 45, 80 50 Q 80 55, 75 65 Q 65 80, 50 85"
              stroke="#3B82F6"
              strokeWidth="2"
              fill="none"
              opacity="0.85"
              strokeLinecap="round"
            />
            <path
              d="M 50 85 Q 35 80, 25 65 Q 20 55, 20 50 Q 20 45, 25 35 Q 35 20, 50 15"
              stroke="#EC4899"
              strokeWidth="2"
              fill="none"
              opacity="0.85"
              strokeLinecap="round"
            />
            <path
              d="M 30 25 Q 40 30, 50 40 Q 55 45, 55 50"
              stroke="#06B6D4"
              strokeWidth="1.8"
              fill="none"
              opacity="0.75"
              strokeLinecap="round"
            />
            <path
              d="M 70 75 Q 60 70, 50 60 Q 45 55, 45 50"
              stroke="#EF4444"
              strokeWidth="1.8"
              fill="none"
              opacity="0.75"
              strokeLinecap="round"
            />
            <path
              d="M 70 25 Q 60 30, 50 40"
              stroke="#10B981"
              strokeWidth="1.6"
              fill="none"
              opacity="0.7"
              strokeLinecap="round"
            />
            <path
              d="M 30 75 Q 40 70, 50 60"
              stroke="#8B5CF6"
              strokeWidth="1.6"
              fill="none"
              opacity="0.7"
              strokeLinecap="round"
            />
            <circle cx="50" cy="50" r="8" fill="url(#grad1)" opacity="0.3" />
            <circle cx="50" cy="50" r="4" fill="#10B981" opacity="0.9" />
          </svg> */}
          {/* Elegant converging tributaries - the essence of Climate River */}
          {/* <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 100 100"
            className="w-6 h-6"
          >
            <path
              d="M 20 10 Q 30 20, 40 35 Q 45 45, 50 55"
              stroke="#3B82F6"
              strokeWidth="2.5"
              fill="none"
              strokeLinecap="round"
              opacity="0.8"
            />
            <path
              d="M 80 10 Q 70 20, 60 35 Q 55 45, 50 55"
              stroke="#EC4899"
              strokeWidth="2.5"
              fill="none"
              strokeLinecap="round"
              opacity="0.8"
            />
            <path
              d="M 10 40 Q 20 42, 30 48 Q 40 52, 50 58"
              stroke="#06B6D4"
              strokeWidth="2.5"
              fill="none"
              strokeLinecap="round"
              opacity="0.8"
            />
            <path
              d="M 90 40 Q 80 42, 70 48 Q 60 52, 50 58"
              stroke="#EF4444"
              strokeWidth="2.5"
              fill="none"
              strokeLinecap="round"
              opacity="0.8"
            />
            <path
              d="M 15 60 Q 25 62, 35 64 Q 42 62, 48 62"
              stroke="#10B981"
              strokeWidth="2.5"
              fill="none"
              strokeLinecap="round"
              opacity="0.8"
            />
            <path
              d="M 85 60 Q 75 62, 65 64 Q 58 62, 52 62"
              stroke="#8B5CF6"
              strokeWidth="2.5"
              fill="none"
              strokeLinecap="round"
              opacity="0.8"
            />
            <path
              d="M 50 60 L 50 90"
              stroke="#10B981"
              strokeWidth="6"
              fill="none"
              strokeLinecap="round"
              opacity="0.5"
            />
            <circle cx="50" cy="60" r="4" fill="#10B981" opacity="0.9" />
          </svg> */}
          {/* Interlocking rings/orbits design */}
          {/* <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 100 100"
            className="w-6 h-6"
          >
            <circle
              cx="50"
              cy="50"
              r="35"
              stroke="#3B82F6"
              strokeWidth="3"
              fill="none"
              opacity="0.7"
            />
            <circle
              cx="50"
              cy="50"
              r="28"
              stroke="#EC4899"
              strokeWidth="3"
              fill="none"
              opacity="0.7"
              strokeDasharray="5,5"
            />
            <ellipse
              cx="50"
              cy="50"
              rx="38"
              ry="20"
              stroke="#06B6D4"
              strokeWidth="3"
              fill="none"
              opacity="0.7"
              transform="rotate(30 50 50)"
            />
            <ellipse
              cx="50"
              cy="50"
              rx="38"
              ry="20"
              stroke="#EF4444"
              strokeWidth="3"
              fill="none"
              opacity="0.7"
              transform="rotate(-30 50 50)"
            />
            <ellipse
              cx="50"
              cy="50"
              rx="20"
              ry="38"
              stroke="#10B981"
              strokeWidth="3"
              fill="none"
              opacity="0.7"
              transform="rotate(60 50 50)"
            />
            <ellipse
              cx="50"
              cy="50"
              rx="20"
              ry="38"
              stroke="#8B5CF6"
              strokeWidth="3"
              fill="none"
              opacity="0.7"
              transform="rotate(-60 50 50)"
            />
            <circle cx="50" cy="50" r="6" fill="#10B981" opacity="0.9" />
            <circle cx="50" cy="50" r="3" fill="white" opacity="0.9" />
          </svg> */}
          {/* Crazy spiraling vortex design */}
          {/* <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 100 100"
            className="w-6 h-6"
          >
            <path
              d="M 50 50 Q 55 30, 70 25 T 85 30"
              stroke="#3B82F6"
              strokeWidth="5"
              fill="none"
              strokeLinecap="round"
              opacity="0.85"
            />
            <path
              d="M 50 50 Q 70 55, 75 70 T 70 85"
              stroke="#EC4899"
              strokeWidth="5"
              fill="none"
              strokeLinecap="round"
              opacity="0.85"
            />
            <path
              d="M 50 50 Q 45 70, 30 75 T 15 70"
              stroke="#06B6D4"
              strokeWidth="5"
              fill="none"
              strokeLinecap="round"
              opacity="0.85"
            />
            <path
              d="M 50 50 Q 30 45, 25 30 T 30 15"
              stroke="#EF4444"
              strokeWidth="5"
              fill="none"
              strokeLinecap="round"
              opacity="0.85"
            />
            <path
              d="M 50 50 Q 60 35, 75 35 T 88 42"
              stroke="#10B981"
              strokeWidth="4"
              fill="none"
              strokeLinecap="round"
              opacity="0.75"
            />
            <path
              d="M 50 50 Q 40 65, 25 65 T 12 58"
              stroke="#8B5CF6"
              strokeWidth="4"
              fill="none"
              strokeLinecap="round"
              opacity="0.75"
            />
            <circle cx="50" cy="50" r="8" fill="white" opacity="0.9" />
            <circle cx="50" cy="50" r="4" fill="#10B981" opacity="0.8" />
          </svg> */}
          {/* New organic blob/droplet design */}
          {/* <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 100 100"
            className="w-6 h-6"
          >
            <circle cx="50" cy="50" r="35" fill="#3B82F6" opacity="0.25" />
            <ellipse
              cx="50"
              cy="35"
              rx="18"
              ry="25"
              fill="#3B82F6"
              opacity="0.7"
            />
            <ellipse
              cx="65"
              cy="50"
              rx="25"
              ry="18"
              fill="#EC4899"
              opacity="0.7"
            />
            <ellipse
              cx="50"
              cy="65"
              rx="18"
              ry="25"
              fill="#06B6D4"
              opacity="0.7"
            />
            <ellipse
              cx="35"
              cy="50"
              rx="25"
              ry="18"
              fill="#EF4444"
              opacity="0.7"
            />
            <ellipse
              cx="60"
              cy="40"
              rx="15"
              ry="20"
              fill="#10B981"
              opacity="0.7"
              transform="rotate(45 60 40)"
            />
            <ellipse
              cx="40"
              cy="60"
              rx="15"
              ry="20"
              fill="#8B5CF6"
              opacity="0.7"
              transform="rotate(-45 40 60)"
            />
            <circle cx="50" cy="50" r="12" fill="white" opacity="0.8" />
          </svg> */}
          {/* Diagonal flowing version - rotated wavy streams */}
          {/* <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 100 100"
            className="w-6 h-6"
            style={{ transform: 'rotate(45deg)' }}
          >
            <path
              d="M 10 20 Q 20 15, 30 20 T 50 20 T 70 20 T 90 20"
              stroke="#3B82F6"
              strokeWidth="4"
              fill="none"
              strokeLinecap="round"
              opacity="0.85"
            />
            <path
              d="M 10 32 Q 25 27, 35 32 T 55 32 T 75 32 T 90 32"
              stroke="#EC4899"
              strokeWidth="4"
              fill="none"
              strokeLinecap="round"
              opacity="0.85"
            />
            <path
              d="M 10 44 Q 20 39, 40 44 T 60 44 T 80 44 T 90 44"
              stroke="#06B6D4"
              strokeWidth="4"
              fill="none"
              strokeLinecap="round"
              opacity="0.85"
            />
            <path
              d="M 10 56 Q 25 51, 35 56 T 55 56 T 75 56 T 90 56"
              stroke="#EF4444"
              strokeWidth="4"
              fill="none"
              strokeLinecap="round"
              opacity="0.85"
            />
            <path
              d="M 10 68 Q 20 63, 30 68 T 50 68 T 70 68 T 90 68"
              stroke="#10B981"
              strokeWidth="4"
              fill="none"
              strokeLinecap="round"
              opacity="0.85"
            />
            <path
              d="M 10 80 Q 25 75, 40 80 T 60 80 T 80 80 T 90 80"
              stroke="#8B5CF6"
              strokeWidth="4"
              fill="none"
              strokeLinecap="round"
              opacity="0.85"
            />
          </svg> */}
          {/* Horizontal flowing version */}
          {/* <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 100 100"
            className="w-6 h-6"
          >
            <path
              d="M 10 20 Q 20 15, 30 20 T 50 20 T 70 20 T 90 20"
              stroke="#3B82F6"
              strokeWidth="4"
              fill="none"
              strokeLinecap="round"
              opacity="0.85"
            />
            <path
              d="M 10 32 Q 25 27, 35 32 T 55 32 T 75 32 T 90 32"
              stroke="#EC4899"
              strokeWidth="4"
              fill="none"
              strokeLinecap="round"
              opacity="0.85"
            />
            <path
              d="M 10 44 Q 20 39, 40 44 T 60 44 T 80 44 T 90 44"
              stroke="#06B6D4"
              strokeWidth="4"
              fill="none"
              strokeLinecap="round"
              opacity="0.85"
            />
            <path
              d="M 10 56 Q 25 51, 35 56 T 55 56 T 75 56 T 90 56"
              stroke="#EF4444"
              strokeWidth="4"
              fill="none"
              strokeLinecap="round"
              opacity="0.85"
            />
            <path
              d="M 10 68 Q 20 63, 30 68 T 50 68 T 70 68 T 90 68"
              stroke="#10B981"
              strokeWidth="4"
              fill="none"
              strokeLinecap="round"
              opacity="0.85"
            />
            <path
              d="M 10 80 Q 25 75, 40 80 T 60 80 T 80 80 T 90 80"
              stroke="#8B5CF6"
              strokeWidth="4"
              fill="none"
              strokeLinecap="round"
              opacity="0.85"
            />
          </svg> */}
          {/* Climate River Logo */}
          {/* <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 512 512"
            className="w-6 h-6"
          >
            <circle cx="256" cy="256" r="200" fill="#10b981"></circle>
            <circle
              cx="256"
              cy="256"
              r="84"
              fill="#059669"
              opacity="0.22"
            ></circle>
          </svg> */}
          {/* Category Icons */}
          <div className="flex items-center gap-2">
            <Landmark className="w-4 h-4 text-[#3B82F6]" />
            <Megaphone className="w-4 h-4 text-[#EC4899]" />
            <Factory className="w-4 h-4 text-[#06B6D4]" />
            <AlertTriangle className="w-4 h-4 text-[#EF4444]" />
            <Zap className="w-4 h-4 text-[#10B981]" />
            <Microscope className="w-4 h-4 text-[#8B5CF6]" />
          </div>
        </div>
      </div>
      <p className="mt-3 text-zinc-700 text-pretty">
        Despite being one of the defining crises of our time, the climate crisis
        is often overshadowed by political maneuvering and the outrage cycle.
        Climate River brings focus to the latest climate news by aggregating
        articles from leading outlets, organizing by story, and ranking for
        trust and timeliness. Inspired by{" "}
        <a
          href="https://techmeme.com"
          target="_blank"
          rel="noreferrer"
          className="underline decoration-zinc-300 hover:decoration-zinc-500"
        >
          Techmeme
        </a>
        .
      </p>
      <p className="mt-3 text-zinc-700 text-pretty">
        If you have feedback or suggestions, please email me at
        contact@climateriver.org
      </p>
      <hr className="my-4 border-zinc-200" />
      <p className="mt-3 text-zinc-700 text-pretty">
        Built with Next.js, Tailwind, and Postgres.{" "}
        <a
          href="https://github.com/dwahbe/climate-river"
          target="_blank"
          rel="noreferrer"
          className="underline decoration-zinc-300 hover:decoration-zinc-500"
        >
          Code&nbsp;available on GitHub
        </a>
        .
      </p>

      <p className="mt-3 text-zinc-700 text-pretty">
        Created by{" "}
        <a
          href="https://dylanwahbe.com"
          target="_blank"
          rel="noreferrer"
          className="underline decoration-zinc-300 hover:decoration-zinc-500"
        >
          Dylan Wahbe
        </a>
        .
      </p>
      <details className="group mt-8 mb-8 rounded-xl p-2 border border-[#096] border-spacing-1 open:bg-zinc-50 transition-colors grid">
        <summary className="font-sans font-medium group-open:text-zinc-900 rounded-b-lg transition-colors cursor-pointer pl-1 flex items-center gap-2 outline-offset-8 group-open:outline-zinc-300 overflow-clip">
          <svg
            className="text-zinc-600 -rotate-45 group-open:rotate-0 transition-transform"
            fillRule="evenodd"
            clipRule="evenodd"
            strokeLinejoin="round"
            strokeMiterlimit="1.414"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
            viewBox="0 0 32 32"
            preserveAspectRatio="xMidYMid meet"
            fill="currentColor"
            width="24"
            height="24"
          >
            <path d="M11.121,9.707c-0.39,-0.391 -1.024,-0.391 -1.414,0c-0.391,0.39 -0.391,1.024 0,1.414l4.95,4.95l-4.95,4.95c-0.391,0.39 -0.391,1.023 0,1.414c0.39,0.39 1.024,0.39 1.414,0l4.95,-4.95l4.95,4.95c0.39,0.39 1.023,0.39 1.414,0c0.39,-0.391 0.39,-1.024 0,-1.414l-4.95,-4.95l4.95,-4.95c0.39,-0.39 0.39,-1.024 0,-1.414c-0.391,-0.391 -1.024,-0.391 -1.414,0l-4.95,4.95l-4.95,-4.95Z"></path>
          </svg>
          Small disclaimer
        </summary>
        <div className="grid gap-6 md:gap-6 p-2 text-zinc-700 text-pretty font-mono-slabs weight-book">
          <p className="text-pretty">
            Climate River is in beta. I’m improving article clustering & scoring
            and adding more sources—especially independent and local outlets. I
            built Climate River to help people cut through the noise and
            understand the climate crisis, its impacts, and the political and
            technological solutions to ameliorate it.
          </p>
        </div>
      </details>
    </div>
  );
}
