export type ArticleLike = { title: string; summary?: string | null };

/**
 * Escape special regex characters in a string for use in RegExp constructor
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Refined 6-category structure for climate news
export const CATEGORIES = [
  {
    slug: "government",
    name: "Government",
    description: "Government policy, regulations, and climate laws",
    longDescription:
      "Track climate legislation, EPA regulations, international climate agreements, and government action on emissions. Coverage spans executive orders, congressional debates, state-level policies, and global summits like COP from outlets including E&E News, Politico, Reuters, and The Guardian.",
    color: "var(--color-cat-government)",
    keywords: [
      "epa",
      "ferc",
      "sec",
      "eu",
      "parliament",
      "countries",
      "nations",
      "ministers",
      "regulation",
      "rules",
      "rule",
      "mandate",
      "standard",
      "summit",
      "cop",
      "un climate",
      "court",
      "lawsuit",
      "bill",
      "policy",
      "permitting",
      "government",
      "federal",
      "congress",
      "senate",
      "biden",
      "trump",
      "climate law",
      "paris agreement",
      "carbon tax",
      "emissions standard",
      "administration",
      "regulatory",
      "compliance",
      "environmental law",
      "energy secretary",
      "department of energy",
      "subsidies",
      "tax credit",
      "legislation",
      "executive order",
      "white house",
      "department",
      "agency",
      "commission",
      "regulator",
      "regulators",
      "approval",
      "approvals",
      "supervisory body",
    ],
    patterns: [
      /(epa|ferc|sec|parliament|regulation|rules?|mandate|standard|court|lawsuit|bill|policy|permitting)/i,
      /(government|federal|congress|senate|house|administration|regulatory|compliance)/i,
      /(carbon tax|emissions? standard|climate law|environmental law|energy secretary)/i,
      /(department of energy|subsidies|tax credit|legislation|executive order)/i,
      /\b(trump|biden|administration|government|regulators?|commission|agency|court)\b.{0,80}\b(halts?|blocks?|cancels?|approves?|denies|deny|limits?|orders?|permits?)\b/i,
      /\brepresentatives?\b.{0,60}\b(countries|nations|governments?|ministers?|summit|cop\d+|un|eu)\b/i,
      /\b(conference|summit|meeting)\b.{0,120}\b(transitioning away from fossil fuels|path beyond fossil fuels|fossil fuel era|phase[- ]out)\b/i,
      /\b(un|paris agreement|supervisory body|article 6(?:\.4)?)\b.{0,100}\b(rules?|registry|procedure|crediting mechanism|carbon credit|climate policy)\b/i,
      /\b(countries|nations|governments?|ministers?|summit|cop\d+|un|eu)\b.{0,100}\b(climate|fossil fuels?|phase[- ]out|energy transition|emissions?|carbon)\b/i,
    ],
  },
  {
    slug: "justice",
    name: "Activism",
    description:
      "Climate protests, rallies, strikes, and direct action by grassroots movements and activist organizations",
    longDescription:
      "Follow climate protests, grassroots movements, and direct action campaigns from organizations like Extinction Rebellion, Just Stop Oil, and Fridays for Future. Coverage includes rallies, strikes, civil disobedience, and the intersection of climate justice with social movements worldwide.",
    color: "var(--color-cat-activism)",
    keywords: [
      // Specific activist organizations
      "extinction rebellion",
      "fridays for future",
      "sunrise movement",
      "just stop oil",
      "350.org",
      "climate defiance",

      // Direct action terms
      "protest",
      "protesters",
      "demonstrators",
      "climate strike",
      "school strike",
      "sit-in",
      "civil disobedience",
      "direct action",

      // Activist-specific terms
      "climate activist",
      "climate activists",
      "climate activism",
      "grassroots climate movement",
      "climate justice",

      // Specific movement actions
      "occupy",
      "encampment",
      "hunger strike",
      "tree sit",
    ],
    patterns: [
      /\b(climate|environmental|fossil[- ]fuel|pipeline|coal|greenwashing|anti[- ]?(?:oil|gas))\s+(protests?|protesters?|demonstrations?|demonstrators?|march(?:es)?|rall(?:y|ies)|strikes?)\b/i,
      /\b(protests?|protesters?|demonstrations?|demonstrators?|march(?:es)?|rall(?:y|ies)|strikes?)\b.{0,80}\b(climate|environmental|fossil[- ]fuel|pipeline|coal|emissions?|greenwashing|anti[- ]?(?:oil|gas))\b/i,
      /(extinction rebellion|fridays for future|sunrise movement|just stop oil|climate defiance)/i,
      /\bgreenpeace\b.{0,80}\b(protests?|campaigns?|activists?|blockad(?:e|ed|es|ing)|direct action)\b/i,
      /\b(protests?|campaigns?|activists?|blockad(?:e|ed|es|ing)|direct action)\b.{0,80}\bgreenpeace\b/i,
      /(civil disobedience|direct action|sit-in|tree sit|hunger strike)/i,
      /\b(blockad(?:e|ed|es|ing)|disrupt(?:ed|s|ing|ion)?|arrests?|arrested)\b.{0,80}\b(protesters?|activists?|campaigners?|demonstrators?|direct action)\b/i,
      /\b(protesters?|activists?|campaigners?|demonstrators?|direct action)\b.{0,80}\b(blockad(?:e|ed|es|ing)|disrupt(?:ed|s|ing|ion)?|arrests?|arrested)\b/i,
      /(climate activists?|climate activism|grassroots climate movement|climate justice)/i,
      /(occupy|encampment|arrested.*protest)/i,
    ],
  },
  {
    slug: "business",
    name: "Business",
    description: "Corporate climate action, finance, and market trends",
    longDescription:
      "Monitor corporate net-zero commitments, ESG developments, carbon markets, and climate finance. Coverage spans green bonds, sustainable investing, supply chain decarbonization, and industry transitions from Bloomberg Green, Financial Times, and Reuters.",
    color: "var(--color-cat-business)",
    keywords: [
      "company",
      "corporation",
      "business",
      "industry",
      "ceo",
      "executive",
      "sustainability",
      "net zero",
      "carbon neutral",
      "emissions reduction",
      "supply chain",
      "manufacturing",
      "retail",
      "airline",
      "shipping",
      "automotive",
      "investment",
      "funding",
      "cost",
      "price",
      "market",
      "stock",
      "bond",
      "esg",
      "carbon credit",
      "carbon market",
      "green finance",
      "climate finance",
      "sustainable finance",
      "divest",
      "pension",
      "insurance",
      "subsidy",
      "tax credit",
      "carbon pricing",
    ],
    patterns: [
      /(company|corporation|business|industry|ceo|executive)/i,
      /(sustainability|net zero|carbon neutral|emissions reduction)/i,
      /(supply chain|manufacturing|retail|airline|shipping|automotive)/i,
      /(investment|funding|cost|price|market|stock|bond)/i,
      /(esg|carbon credit|carbon market|green finance|climate finance)/i,
    ],
  },
  {
    slug: "impacts",
    name: "Impacts",
    description:
      "Climate effects, extreme weather, and environmental consequences",
    longDescription:
      "Stay informed on extreme weather events, rising sea levels, biodiversity loss, and the real-world consequences of climate change. Coverage includes hurricanes, wildfires, droughts, flooding, and their effects on communities, agriculture, and ecosystems worldwide.",
    color: "var(--color-cat-impacts)",
    keywords: [
      "hurricane",
      "flood",
      "drought",
      "wildfire",
      "heatwave",
      "storm",
      "tornado",
      "cyclone",
      "sea level",
      "glacier",
      "ice sheet",
      "arctic",
      "coral",
      "species",
      "extinction",
      "ecosystem",
      "biodiversity",
      "wildlife",
      "habitat",
      "habitats",
      "amphibian",
      "amphibians",
      "agriculture",
      "food security",
      "extreme weather",
      "climate impact",
      "environmental damage",
      "climate refugee",
      "climate migration",
      "climate displacement",
      "displaced by climate",
    ],
    patterns: [
      /(hurricane|flood|drought|wildfire|heatwave|storm|tornado|cyclone)/i,
      /(sea level|glacier|ice sheet|arctic|coral|species|extinction)/i,
      /(ecosystem|biodiversity|wildlife|habitats?|amphibians?|agriculture|food security)/i,
      /\bcrops?\b.{0,40}\b(damage|damaged|failure|fail|failed|loss|losses|yield|yields|production|harvest)\b/i,
      /\b(damage|damaged|failure|fail|failed|loss|losses|yield|yields|production|harvest)\b.{0,40}\bcrops?\b/i,
      /(animal migration|species migration|warming winters|drying pools)/i,
      /(climate (refugee|migration|displacement)|displaced by climate)/i,
      // Definitive disaster + casualty patterns (high confidence signals)
      // Note: Use \w* suffixes to match plurals (floods, storms) and -ing forms (flooding)
      /\b(death toll|kills?|killed|dead|deaths?|casualties|victims?|lives? (lost|claimed)|claiming.{0,10}lives)\b.{0,60}\b(flood\w*|storm\w*|hurricane|wildfire|cyclone|typhoon|tornado|drought)\b/i,
      /\b(flood\w*|storm\w*|hurricane|wildfire|cyclone|typhoon|tornado)\b.{0,60}\b(kills?|killed|deaths?|dead|casualties|victims?|devastat\w*|claiming.{0,10}lives)\b/i,
      /\b(evacuat\w*|displac\w*|homeless|stranded)\b.{0,60}\b(flood\w*|storm\w*|fire|hurricane|cyclone|typhoon|tornado)\b/i,
    ],
  },
  {
    slug: "tech",
    name: "Tech",
    description: "Clean technology, renewables, and climate solutions",
    longDescription:
      "Explore breakthroughs in renewable energy, electric vehicles, carbon capture, battery storage, and other climate solutions. Coverage from Canary Media, CleanTechnica, and Heatmap News tracks the technologies driving the energy transition.",
    color: "var(--color-cat-tech)",
    keywords: [
      "technology",
      "innovation",
      "startup",
      "carbon capture",
      "ccus",
      "direct air capture",
      "hydrogen",
      "electric vehicle",
      "ev",
      "tesla",
      "battery",
      "smart grid",
      "artificial intelligence",
      "ai technology",
      "sensor network",
      "monitoring technology",
      "climate platform",
      "climate software",
      "solar panel",
      "solar cell",
      "solar cells",
      "solar power",
      "wind turbine",
      "wind farm",
      "wind farms",
      "renewable energy",
      "grid storage",
      "electricity generation",
      "nuclear power",
      "energy storage",
      "transmission line",
      "utility scale",
      "clean tech",
      "cleantech",
    ],
    patterns: [
      /(technology|innovation|startup|carbon capture|ccus|direct air capture)/i,
      // Word boundaries around ev/evs to prevent matching "severe", "evacuated", etc.
      /\b(hydrogen|electric vehicles?|evs?|tesla|battery|smart grid)\b/i,
      /\b(artificial intelligence|ai|machine learning)\b.{0,80}\b(climate|energy|emissions?|methane|deforestation|wildfire|grid|carbon|solar|wind)\b/i,
      /\b(satellite|sensor|monitoring|platform|software|algorithm)\b.{0,80}\b(technology|system|network|tool|detect|track|measure|monitor|emissions?|methane|deforestation)\b/i,
      /(solar panels?|solar cells?|solar power|wind turbines?|wind farms?|renewable energy|grid storage|energy storage)/i,
      /(nuclear power|transmission line|utility scale|clean tech|cleantech)/i,
    ],
  },
  {
    slug: "research",
    name: "Research & Innovation",
    description: "Climate research, studies, and scientific discoveries",
    longDescription:
      "Read the latest climate science from peer-reviewed studies, IPCC reports, and research institutions. Coverage includes new findings on warming projections, atmospheric science, oceanography, and climate modeling from Nature, Scientific American, and NASA.",
    color: "var(--color-cat-research)",
    keywords: [
      "study shows",
      "study finds",
      "study reveals",
      "research shows",
      "research finds",
      "scientists discover",
      "scientists find",
      "new research",
      "peer review",
      "journal",
      "paper",
      "analysis shows",
      "findings show",
      "evidence shows",
      "data reveals",
      "climate model",
      "simulation",
      "peer-reviewed",
      "scientific study",
      "climate science",
      "atmospheric science",
      "oceanography",
      "ipcc report",
      "science journal",
      "nature journal",
      "science magazine",
      "research paper",
      "academic study",
      "university research",
      // Add broader but still research-specific terms
      "study",
      "research",
      "researcher",
      "researchers",
      "scientist",
      "scientists",
      "scientific",
      "findings",
      "data",
      "analysis",
      "report",
      "university",
      "academic",
    ],
    patterns: [
      /(study (shows|finds|reveals)|research (shows|finds)|scientists (discover|find))/i,
      /\b(researchers?|scientists?)\b.{0,80}\b(detect|record|identify|propose|document|find|discover|measure|observe)\b/i,
      /(new research|peer.?review|journal|paper)/i,
      /\b(study|paper|article)\s+on\b/i,
      /(analysis shows|findings show|evidence shows|data reveals)/i,
      /(climate model|simulation|peer.?reviewed|scientific study)/i,
      /(ipcc report|science journal|nature journal|research paper|academic)/i,
      // Removed: negative lookahead pattern was flawed (only worked if weather terms came after)
    ],
  },
] as const;

export type CategorySlug = (typeof CATEGORIES)[number]["slug"];

export interface CategoryScore {
  slug: CategorySlug;
  confidence: number;
  reasons: string[];
  ruleConfidence?: number;
  semanticConfidence?: number;
  confidenceSource?: "rule" | "semantic" | "hybrid";
}

// Category lookup helper
export function getCategoryBySlug(slug: string) {
  return CATEGORIES.find((c) => c.slug === slug);
}

/**
 * Clean summaries before relevance/category scoring. Some feed deks are
 * newsletter roundups or publisher boilerplate rather than article context.
 */
export function cleanCategorizationSummary(
  summary?: string | null,
): string | undefined {
  if (!summary) {
    return undefined;
  }

  const normalized = summary.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return undefined;
  }

  if (/^current conditions:/i.test(normalized)) {
    return undefined;
  }

  const withoutPublisherPrefix = normalized
    .replace(
      /^(?:Nature|Nature Climate),?\s*Published online:\s*\d{1,2}\s+\w+\s+\d{4};\s*doi:\S+\s*/i,
      "",
    )
    .replace(/^This story is co-published with [^.]+\.\s*/i, "")
    .replace(/^Welcome to [^.]+ briefing\.\s*/i, "")
    .trim();

  return withoutPublisherPrefix || undefined;
}

export function normalizeArticleForCategorization(
  article: ArticleLike,
): ArticleLike {
  return {
    title: article.title,
    summary: cleanCategorizationSummary(article.summary),
  };
}

/**
 * Check if an article is climate-relevant by requiring at least one climate-related term.
 * This prevents non-climate political/business news from slipping through.
 *
 * TODO: This is prone to both false positives and false negatives. A simple way to improve this is to use LLMs to check the article + summary.
 */
export function isClimateRelevant(article: ArticleLike): boolean {
  const normalized = normalizeArticleForCategorization(article);
  const text = `${normalized.title} ${normalized.summary || ""}`.toLowerCase();

  const climateTerms = [
    // Core climate terms
    /\b(climate|carbon|carbon dioxide|co2|emission|greenhouse|warming|global warming)\b/i,

    // Energy & renewables (bare "wind"/"energy" are handled via the
    // ambiguous-term + climate-context gate below to avoid false positives like
    // "wind blows away parade balloons" / "energy drink")
    /\b(renewables?|fossil|solar|hydroelectric|geothermal|biomass)\b/i,
    /\b(wind (?:farm|farms|turbine|turbines|power|energy)|offshore wind|onshore wind)\b/i,
    // Unambiguous climate-tech / energy-transition terms
    /\bheat pumps?\b/i,
    /\b(gas|petrol|diesel|combustion)[- ](cars?|vehicles?|powered|engines?)\b/i,
    /\binternal combustion\b/i,
    /\b(go|going|gone)\s+electric\b/i,
    /\belectrif(?:y|ied|ication|ying)\b/i,
    /\b(ev|evs|electric[- ]vehicles?|electric[- ]cars?|plug-in|battery[- ]electric|tesla)\b/i,
    /\b(battery|batteries|charging station|charging network|grid storage|long-duration storage)\b/i,
    /\b(hydrogen|ammonia|electrolyzer|fuel cell)\b/i,
    /\b(nuclear (?:power|energy|plant|plants|reactor|reactors)|reactors?|fusion|fission|small modular reactor)\b/i,

    // Fossil fuels (bare "oil"/"gas"/"mining"/"mine" handled via the
    // ambiguous-term gate below; specific multiword forms stay strong here)
    /\b(methane|petroleum|petrochemical|refinery|refineries|diesel|jet fuel|kerosene)\b/i,
    /\b(crude oil|oil spill|oil rig|oil sands|natural gas|shale gas|gas flaring|offshore drilling)\b/i,
    /\b(coal|strip mine|mountaintop removal)\b/i,
    /\b(fracking|drilling|offshore rig|rigs|pipeline|pipelines|liquefied natural gas|lng)\b/i,

    // Weather & climate impacts
    /\b(flood|floods|flooding|flooded|floodwater|floodwaters)\b/i,
    /\b(drought|droughts|water shortage|water scarcity)\b/i,
    /\b(storm|storms|tropical storm|storm surge|hurricane|typhoon|cyclone|tornado|tornadoes)\b/i,
    /\b(atmospheric river|heavy rain|heavy rainfall|torrential rain|deluge)\b/i,
    /\b(wildfire|wildfires|fire danger|fire weather|smoke plume|smoke plumes|bushfire)\b/i,
    /\b(heatwave|heat wave|heatwaves|heat waves|heat dome|heat domes|heat index|extreme heat|hot weather)\b/i,
    /\b(mudslide|mudslides|landslide|landslides|debris flow)\b/i,
    /\b(extreme weather|severe weather|climate crisis|climate emergency|climate disaster)\b/i,

    // Ecosystems & biodiversity
    /\b(sea[- ]?level|rising seas|coastal flooding|ocean warming|ocean acidification)\b/i,
    /\b(glacier|glaciers|ice sheet|ice sheets|arctic|antarctic|polar (?:ice|region|regions|warming|climate)|permafrost|ice melt)\b/i,
    /\b(coral|coral reef|coral bleaching|marine life|ocean)\b/i,
    /\b(deforestation|rainforest|amazon rainforest|logging|reforestation)\b/i,
    /\bforests?\b.{0,60}\b(loss|degradation|clearing|carbon|emissions?|climate|wildfires?|fire|conservation|restoration)\b/i,
    /\b(loss|degradation|clearing|carbon|emissions?|climate|wildfires?|fire|conservation|restoration)\b.{0,60}\bforests?\b/i,
    /\b(ecosystem|ecosystems|biodiversity|species extinction|habitat loss|endangered species)\b/i,
    /\b(agriculture|agricultural|farming|farmers|food security|food supply|harvest)\b/i,
    /\bcrops?\b.{0,40}\b(damage|damaged|failure|fail|failed|loss|losses|yield|yields|production|harvest)\b/i,
    /\b(damage|damaged|failure|fail|failed|loss|losses|yield|yields|production|harvest)\b.{0,40}\bcrops?\b/i,
    /\b(water crisis|water stress|precipitation|rainfall|snowpack)\b/i,
    /\b(rising|increasing|record|extreme|maximum summer)\s+temperatures?\b/i,
    /\b(colorado river|colorado river basin|river compact|water (?:allocation|allocations|allotment|sharing))\b/i,

    // Environmental & pollution
    /\b(environmental|environment|pollution|pollutants|microplastics?|air quality|water quality|soot|smog)\b/i,

    // Technology & innovation
    /\b(carbon capture|ccus|ccs|direct air capture|carbon removal|carbon sequestration)\b/i,
    /\b(clean energy|clean tech|cleantech|green tech|green energy)\b/i,
    /\b(smart grid|microgrid|transmission line|utility scale)\b/i,

    // Policy & regulation
    /\b(epa|environmental protection|ferc|sec.*climate|climate policy|climate law)\b/i,
    /\b(carbon tax|carbon pricing|emissions? standard|emissions? trading|cap and trade)\b/i,
    /\b(paris agreement|cop\d+|ipcc|unfccc|net zero|net-zero)\b/i,

    // Activism & organizations
    /\b(climate strike|climate protest|climate march|climate rally|climate activist)\b/i,
    /\b(extinction rebellion|fridays for future|sunrise movement|just stop oil)\b/i,
    /\b(greenpeace|sierra club|friends of the earth|350\.org|earthjustice)\b/i,
    /\b(world wildlife fund|wwf|union of concerned scientists)\b/i,

    // Finance & business
    /\b(esg.*climate|climate.*esg|green finance|climate finance|sustainable finance)\b/i,
    /\b(carbon credit|carbon market|carbon offset|climate risk)\b/i,
    /\b(divest.*fossil|stranded asset|climate disclosure)\b/i,
  ];

  if (climateTerms.some((pattern) => pattern.test(text))) {
    return true;
  }

  // Energy-domain terms (wind/energy/electricity/grid) are climate-relevant in
  // this aggregator by DEFAULT — the corpus is climate/energy news — EXCEPT for
  // a few clearly non-climate uses (weather "wind gusts", "energy drink"). An
  // empirical scan over production data showed that requiring an explicit cue
  // here dropped genuine energy-transition coverage (wind industry, repowering,
  // electricity schemes), so these default to relevant.
  const energyDomain = /\b(wind|energy|electricity|grid)\b/i;
  const energyDomainNonClimate =
    /\bwind\s+(?:gust|gusts|chill|blow|blows|blowing|blew|knock|knocks|knocked|driven|speed|whipped|down)\b|\benergy\s+drink|\bnervous\s+energy\b/i;
  if (energyDomain.test(text) && !energyDomainNonClimate.test(text)) {
    return true;
  }

  // Heat / temperature as a climate signal: the word "heat" or "temperature(s)"
  // alongside a weather/impact cue (record, wave, swelter, dome, deaths, stress,
  // warming…). Catches "record heat", "heat records", "heat stress", "Europe
  // swelters in record heat", "record-high temperatures" — while excluding bare
  // sports/policy uses ("Miami Heat win in overtime", tennis "heat policy").
  const heatImpactCue =
    /\b(wave|waves|dome|domes|index|record|records|swelter\w*|scorch\w*|sear\w*|blister\w*|soaring|extreme|deadly|dangerous|relentless|prolonged|punishing|warming|climate|wildfire|drought|deaths?|fatalities|mortality|stress|advisory|warning|emergency|humidity|hottest|highest)\b/i;
  if (
    (/\bheat\b/i.test(text) || /\btemperatures?\b/i.test(text)) &&
    heatImpactCue.test(text)
  ) {
    return true;
  }

  // More-ambiguous single words (oil, gas, mining, bare "heat") only count when
  // paired with an explicit climate/energy cue, since they have common
  // non-climate meanings (oil prices, gas station, gold mining, "Miami Heat",
  // tennis "heat policy").
  const ambiguousTerms = /\b(oil|gas|mine|mines|mining|miners|heat)\b/i;
  const climateContext =
    /\b(climate|carbon|emissions?|greenhouse|warming|renewables?|clean energy|energy transition|fossil|decarboniz\w*|net[- ]?zero|coal|power grid|electric grid|grid storage|electricity generation|pollution|environment\w*|sustainab\w*|cop\d+|ipcc|paris agreement|wildfire|drought|heatwave)\b/i;
  if (ambiguousTerms.test(text) && climateContext.test(text)) {
    return true;
  }

  return false;
}

/**
 * Categorize an article based on title and summary using rule-based scoring
 */
export function categorizeArticle(article: ArticleLike): CategoryScore[] {
  const normalized = normalizeArticleForCategorization(article);

  // CRITICAL: First check if article is climate-relevant
  // This prevents non-climate articles from being categorized and appearing in the river
  if (!isClimateRelevant(normalized)) {
    console.log(
      `⚠️  Article filtered out (not climate-relevant): "${normalized.title.substring(0, 60)}..."`,
    );
    return [];
  }

  const { title, summary } = normalized;
  const text = `${title} ${summary || ""}`.toLowerCase();
  const scores: CategoryScore[] = [];

  for (const category of CATEGORIES) {
    let confidence = 0;
    const reasons: string[] = [];

    // Check keywords (weight: 0.3 per match, max 0.9)
    // Using word boundaries to prevent partial matches (e.g., "ev" matching "evacuated")
    let keywordMatches = 0;
    for (const keyword of category.keywords) {
      const keywordPattern = new RegExp(
        `\\b${escapeRegex(keyword.toLowerCase())}\\b`,
      );
      if (keywordPattern.test(text)) {
        keywordMatches++;
        reasons.push(`keyword: ${keyword}`);
      }
    }
    const keywordScore = Math.min(keywordMatches * 0.3, 0.9);
    confidence += keywordScore;

    // Check patterns (weight: 0.4 per match, max 1.2)
    let patternMatches = 0;
    for (const pattern of category.patterns) {
      if (pattern.test(text)) {
        patternMatches++;
        reasons.push(`pattern: ${pattern.source}`);
      }
    }
    const patternScore = Math.min(patternMatches * 0.4, 1.2);
    confidence += patternScore;

    // Include all categories with any signal (filtering happens in storeArticleCategories)
    if (confidence > 0) {
      scores.push({
        slug: category.slug,
        confidence: Math.min(confidence, 1.0), // Cap at 1.0
        reasons,
      });
    }
  }

  // Sort by confidence (highest first)
  return scores.sort((a, b) => b.confidence - a.confidence);
}
