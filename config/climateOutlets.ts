export type ClimateOutlet = {
  name: string;
  domain: string;
  promptHint?: string;
  /**
   * Sweep sizing hint for paid outlet discovery (Exa): "high" volume
   * outlets publish many climate stories a day and get one search each;
   * everything else is batched several domains per call. Default: low.
   */
  volume?: "high" | "low";
};

export const CURATED_CLIMATE_OUTLETS: ClimateOutlet[] = [
  {
    name: "Carbon Brief",
    domain: "carbonbrief.org",
    promptHint: "Carbon Brief climate policy and science explainers",
  },
  {
    name: "Bloomberg Green",
    domain: "bloomberg.com",
    volume: "high",
    promptHint: "Bloomberg Green climate finance and technology coverage",
  },
  {
    name: "Financial Times Climate",
    domain: "ft.com",
    volume: "high",
    promptHint: "FT climate transition and net-zero reporting",
  },
  {
    name: "The New York Times Climate Forward",
    domain: "nytimes.com",
    volume: "high",
    promptHint: "NYT Climate Forward desk",
  },
  {
    name: "Associated Press Climate",
    domain: "apnews.com",
    volume: "high",
    promptHint: "AP News climate desk",
  },
  {
    name: "Reuters Climate",
    domain: "reuters.com",
    volume: "high",
    promptHint: "Reuters climate and energy transition bureau",
  },
  {
    name: "The Guardian Environment",
    domain: "theguardian.com",
    volume: "high",
    promptHint: "Guardian climate and environment desk",
  },
  {
    name: "Washington Post Climate Solutions",
    domain: "washingtonpost.com",
    volume: "high",
    promptHint: "WaPo climate desk and Climate Solutions vertical",
  },
  {
    name: "BBC Future Planet",
    domain: "bbc.com",
    promptHint: "BBC Future Planet climate features",
  },
  {
    name: "National Geographic Climate",
    domain: "nationalgeographic.com",
    promptHint: "National Geographic climate science coverage",
  },
  {
    name: "Grist",
    domain: "grist.org",
    promptHint: "Grist climate justice and solutions reporting",
  },
  {
    name: "Jacobin Climate",
    domain: "jacobin.com",
    promptHint: "Jacobin climate politics coverage",
  },
  {
    name: "Inside Climate News",
    domain: "insideclimatenews.org",
    promptHint: "Inside Climate News investigations",
  },
  {
    name: "Climate Home News",
    domain: "climatechangenews.com",
    promptHint: "Climate Home News global negotiations desk",
  },
  {
    name: "Mongabay Climate",
    domain: "mongabay.com",
    promptHint: "Mongabay deforestation and biodiversity reporting",
  },
  {
    name: "Down To Earth",
    domain: "downtoearth.org.in",
    promptHint: "Down To Earth climate resilience coverage",
  },
  {
    name: "Rest of World",
    domain: "restofworld.org",
    promptHint: "Rest of World climate technology stories",
  },
  {
    name: "Canary Media",
    domain: "canarymedia.com",
    promptHint: "Canary Media clean energy reporting",
  },
  {
    name: "Heatmap News",
    domain: "heatmap.news",
    promptHint: "Heatmap News climate business coverage",
  },
  {
    name: "Yale Climate Connections",
    domain: "yaleclimateconnections.org",
    promptHint: "Yale Climate Connections explainer series",
  },
  {
    name: "E&E News",
    domain: "eenews.net",
    volume: "high",
    promptHint: "E&E News climate policy reporting",
  },
  {
    name: "Politico Climate Wire",
    domain: "politico.com",
    volume: "high",
    promptHint: "Politico climate and energy policy desk",
  },
  {
    name: "CleanTechnica",
    domain: "cleantechnica.com",
    promptHint: "CleanTechnica renewable technology blog",
  },
  {
    name: "Energy Monitor",
    domain: "energymonitor.ai",
    promptHint: "Energy Monitor global transition reporting",
  },
  {
    name: "Carbon Pulse",
    domain: "carbon-pulse.com",
    promptHint: "Carbon Pulse carbon markets briefing",
  },
  {
    name: "Ember",
    domain: "ember-energy.org",
    promptHint: "Ember power sector and electricity transition analysis",
  },
  {
    name: "Rocky Mountain Institute",
    domain: "rmi.org",
    promptHint: "RMI decarbonization insights",
  },
  {
    name: "World Resources Institute",
    domain: "wri.org",
    promptHint: "WRI climate policy analysis",
  },
  {
    name: "International Energy Agency",
    domain: "iea.org",
    promptHint: "IEA clean energy reports and commentary",
  },
  {
    name: "World Economic Forum",
    domain: "weforum.org",
    promptHint: "WEF climate and energy coverage",
  },
  {
    name: "Amnesty International",
    domain: "amnesty.org",
    promptHint: "Amnesty International climate justice statements",
  },
  {
    name: "NASA Earth Observatory",
    domain: "earthobservatory.nasa.gov",
    promptHint: "NASA Earth Observatory climate features",
  },
  {
    name: "NOAA Climate.gov",
    domain: "climate.gov",
    promptHint: "NOAA Climate.gov data stories",
  },
  {
    name: "Project Syndicate",
    domain: "project-syndicate.org",
    promptHint: "Project Syndicate climate op-eds",
  },
  {
    name: "Vox Climate Lab",
    domain: "vox.com",
    promptHint: "Vox climate and energy coverage",
  },
  {
    name: "The Atlantic Planet",
    domain: "theatlantic.com",
    promptHint: "The Atlantic Planet climate column",
  },
  {
    name: "UN News Climate",
    domain: "news.un.org",
    promptHint: "United Nations climate diplomacy updates",
  },
  {
    name: "Nature Climate",
    domain: "nature.com",
    promptHint: "Nature climate science highlights",
  },
  {
    name: "Scientific American Climate",
    domain: "scientificamerican.com",
    promptHint: "Scientific American climate reporting",
  },
  // Added 2026-08-21 (no working RSS feed → discovery sweep only)
  {
    name: "Semafor Net Zero",
    domain: "semafor.com",
    promptHint: "Semafor Net Zero climate and energy newsletter stories",
  },
  {
    name: "DeSmog",
    domain: "desmog.com",
    promptHint: "DeSmog fossil-fuel industry accountability reporting",
  },
  {
    name: "Drilled",
    domain: "drilled.media",
    promptHint: "Drilled climate accountability journalism",
  },
];
