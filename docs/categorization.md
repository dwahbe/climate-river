# Categorization rubric

What counts as climate news on Climate River, and which category an article belongs in. This is the reference for labelling articles in `bun run categorize:eval`. The model questions in `lib/articleJudgment.ts` restate it; change both together and bump `RUBRIC_VERSION`.

Status: draft 3, 2026-09-28. Rulings from Dylan are recorded in section 7.

## How to judge

Judge from the title and summary only. That is all the categorizer sees. When the title is too vague to call and there is no summary, open the article.

Each article gets these labels:

| Label                | Values                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| Climate              | yes or no                                                                                      |
| Primary category     | one category, or none                                                                          |
| Secondary categories | zero or more other categories                                                                  |
| Article type         | one type                                                                                       |
| Story kind           | for impact and weather stories only: signal, linked, event, adaptation, routine, or side_story |

## 1. Is it climate?

The question is whether the article belongs on Climate River, not whether it touches the topic.

Yes when the article is mainly about one of these:

- **Climate change itself**: warming, projections, attribution, climate science.
- **Emissions and their sources**: fossil fuel production, power plants, industrial emissions, methane.
- **The energy transition**: renewables, storage, EVs, the grid, nuclear, hydrogen, carbon capture and removal, critical minerals. These count with or without any mention of climate.
- **Climate policy, law and diplomacy**: legislation, regulation, court cases, COP and other summits.
- **Climate finance and markets**: carbon markets, ESG, climate debt, green investment, corporate targets.
- **Impacts and adaptation**: see the framework below.

No when:

- A climate law or body is only the backdrop. A story on Medicare drug pricing is not climate because the Inflation Reduction Act set the rule.
- It is nature, wildlife or general environment with no stated climate link. A study of Arctic shorebird migration is not climate.
- Climate or energy words appear only in passing, or in another sense (Miami Heat, gas station robbery).
- It is routine weather or a side story (see below).

### Impacts: what kind of evidence is this story?

No single article can show that climate change caused one flood or one fire. So the rubric does not ask that. It asks what kind of evidence the story is.

| Kind         | What it is                                                                                                                                             | Test                           | Climate |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ | ------- |
| `signal`     | A measured change in the climate system or an ecosystem: temperature records, sea level, ice loss, coral bleaching, a seasonal outlook such as El Niño | None                           | yes     |
| `linked`     | An event or problem the text itself ties to climate change: migration, health, failing infrastructure, a disaster scientists attribute                 | The link is stated in the text | yes     |
| `event`      | A flood, wildfire, heat wave, storm, or drought with no stated link                                                                                    | The notable bar                | yes     |
| `adaptation` | Preparing for or adapting to those hazards: flood defences, early warning systems, preparedness advice                                                 | Not a forecast or warning      | yes     |
| `routine`    | A forecast, watch, warning, advisory, tracker, or local status update, or an event below the notable bar                                               |                                | no      |
| `side_story` | A fundraiser, an arrest or criminal case, a sports result, or a community event set against a disaster                                                 |                                | no      |

The site never claims that climate change caused an `event`. It carries floods and fires because they are the hazards climate change is making worse, and the notable bar keeps out the noise. A stated link is required only where the hazard alone does not justify a place, such as wildlife or migration.

Signal and linked stories are stronger evidence than events. The kind is recorded so that ranking can use it later.

### The notable bar

An `event` that has happened or is under way is notable when the text reports at least one of:

- deaths, injuries, or people missing
- evacuations or rescues
- damage to homes, farms, or infrastructure
- a broken record, or a severity word such as extreme or exceptional
- a disaster declaration, emergency measure, or request for aid
- a wide area: several counties, a state, a region, or a country
- a named hurricane or tropical storm that has made impact

With none of these, it is `routine`. Traffic disruption and street flooding alone are routine.

| Example                                                                  | Kind       | Why                     |
| ------------------------------------------------------------------------ | ---------- | ----------------------- |
| Global ocean breaks records with 100 days of heat                        | signal     | Measured change         |
| A species going extinct because of warming                               | linked     | Link stated             |
| Climate change 'destabilising factor' in Nepal landslide, say scientists | linked     | Link stated             |
| How climate change is keeping kids from school                           | linked     | Link stated             |
| Dangerous Heat Wave Arrives Today With Record-Breaking Temps             | event      | Record broken           |
| Torrential rain in Vietnam leaves 3 dead, 16,000 homes flooded           | event      | Deaths, damage          |
| Evacuations underway as fire crews battle wildfire                       | event      | Evacuations             |
| Drought conditions worsen across the Southeast                           | event      | Wide area               |
| New stormwater pump in Virginia Beach to manage flooding                 | adaptation | Flood defence           |
| Heavy rain brings flooding concerns this weekend                         | routine    | Forecast                |
| Flash Flood Warning in Effect in Greenwich                               | routine    | Warning                 |
| Flooding in Otter Tail County                                            | routine    | No sign of scale        |
| Flooding leads to stalled cars, detours in Fort Lauderdale               | routine    | Traffic disruption only |
| Indianapolis Indians raise $25,000 for flood victims                     | side_story | Fundraiser              |
| 3 more teens arrested in connection with deadly Washington wildfire      | side_story | Criminal case           |

## 2. Categories

| Slug         | Name                  | Covers                                                                                                                                                                                              | Does not cover                                                          |
| ------------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `government` | Government            | Laws, regulation, executive action, permits, elections and politicians' positions, international negotiations, public agencies and development banks, court cases brought by or against governments | Company responses to policy (business)                                  |
| `justice`    | Activism              | Protests, strikes, direct action, campaigns by movements and advocacy groups, climate justice claims by affected communities, lawsuits brought by activists, youth, or communities                  | Statements by governments (government)                                  |
| `business`   | Business              | Corporate targets and announcements, deals, investment, carbon markets, ESG, industry and market trends                                                                                             | Technology described on its own merits (tech)                           |
| `impacts`    | Impacts               | Signal, linked, event, and adaptation stories as defined in section 1                                                                                                                               | Studies whose news is the finding itself (research)                     |
| `tech`       | Tech                  | Clean energy and climate technology: projects, products, deployments, engineering advances, cost and performance                                                                                    | Funding rounds and corporate strategy (business)                        |
| `research`   | Research & Innovation | Peer-reviewed studies, scientific reports, new data and models                                                                                                                                      | Reports by advocacy groups or companies (the category of their subject) |

### Lawsuits

The primary category follows who brought the case.

| Case                                                           | Primary      | Secondary                                    |
| -------------------------------------------------------------- | ------------ | -------------------------------------------- |
| Brought by activists, youth, or communities                    | `justice`    | `government` or `business`, by defendant     |
| Brought by a government or regulator                           | `government` | `business` when companies are the defendants |
| Brought against a government's policy by a company or industry | `government` | `business`                                   |

## 3. Choosing the primary category

Pick the category of what happened, not of who reported it or what it might lead to.

1. **Actor and action decide.** A government issuing permits is government. A company launching a product is tech if the story is the product, business if the story is the deal or target.
2. **A study is research only when the finding is the news.** "Study finds Antarctic ice loss accelerating" is research. "Heat wave arrives today" is impacts, even if scientists are quoted.
3. **An event beats its commentary.** A flood is impacts. An opinion piece about flood policy is government.
4. **Use none sparingly.** None means the article is climate but fits no category. Prefer the closest category.

## 4. Secondary categories

Add a secondary category when a reader browsing that category would expect to find the article. Most articles have none or one. Do not add one only because a word from that category appears.

## 5. Article type

| Type            | Meaning                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| `news_report`   | News reporting, feature, or analysis by a news outlet                                                              |
| `opinion`       | Opinion, editorial, or commentary                                                                                  |
| `press_release` | Press release or announcement written from the organization's point of view, including trade-press rewrites of one |
| `promotional`   | Stock tip, sponsored, or promotional content                                                                       |
| `not_news`      | Not an article: event page, correction, tracker, how-to guide, or listing                                          |

A `not_news` item still gets climate and category labels by topic. The type exists so these can be kept out of lead positions.

## 6. Worked examples

Dylan's labels from batch 1 of the 2026-09-27 run, made before the rulings in section 7. Rows marked with an asterisk conflict with a ruling and are listed there.

| Title                                                                                 | Climate | Primary    | Secondary | Type          |
| ------------------------------------------------------------------------------------- | ------- | ---------- | --------- | ------------- |
| US says it could issue deep sea mining permits within months                          | yes     | government | business  | news_report   |
| Dangerous Heat Wave Arrives Today With Record-Breaking Temps                          | yes     | impacts    |           | news_report   |
| Southeast Wisconsin Weather: Heavy rain brings flooding concerns this weekend *       | yes     | impacts    |           | news_report   |
| Flooding in Otter Tail County *                                                       | yes     | impacts    |           | news_report   |
| Yara Launches Sluiskil CCS: 800,000 Tonnes CO2 Capture Annually                       | yes     | tech       | business  | press_release |
| States Are Opening the Door to Data Center Investment in Virtual Power Plants *       | no      |            |           |               |
| At regional summit, Pacific islands demand COP31 support for clean energy and finance | yes     | government | justice   | news_report   |
| UNEP Urges Dual-Target Carbon Accounting                                              | yes     | business   |           |               |
| Opinion: Hong Kong lacks a climate narrative to unify its efforts                     | yes     | government |           | opinion       |
| Fighting Wildfire Haze With an Airplane and Lots of Salt and Water                    | yes     | impacts    |           | news_report   |
| Oil Cos. Escape Mich. Climate Change Antitrust Suit *                                 | yes     | business   | justice   | news_report   |
| Noria Energy debuts single-axis floating solar tracker                                | yes     | tech       | business  | press_release |
| Severe storms bring flooding to El Paso, Juárez                                       | yes     | impacts    |           | news_report   |
| Video, Photos: Flash Flood Warning in Effect in Greenwich *                           | yes     | impacts    |           |               |
| Arctic shorebirds break a migration rule that most birds follow                       | no      |            |           |               |
| Konecranes targets 90 per cent emissions cut by 2050                                  | yes     | business   |           | press_release |
| Track where a potent nor'easter will bring heavy rain, winds and waves *              | yes     | impacts    |           |               |
| Medicare drug coverage faces an ominous spending outlook                              | no      |            |           |               |
| Climate-vulnerable countries spend nearly 25x more repaying debt than climate action  | yes     | government | business  | news_report   |
| Climate change 'destabilising factor' in Nepal landslide, say scientists              | yes     | impacts    | research  | news_report   |

## 7. Rulings

| Date       | Question                                           | Ruling                                                                                                                                                 | Status                   |
| ---------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| 2026-09-28 | Local weather with no climate angle                | It is an impact, to a smaller degree. In only when it clears the notable bar.                                                                          | Decided                  |
| 2026-09-28 | Energy and grid stories that never mention climate | In scope. All energy transition news counts.                                                                                                           | Decided                  |
| 2026-09-28 | Climate lawsuits                                   | Depends on who brought the case: activists or youth is Activism, otherwise Government. See section 2.                                                  | Working rule, to confirm |
| 2026-09-28 | Items that are not articles                        | Add the `not_news` type.                                                                                                                               | Decided                  |
| 2026-09-28 | How to decide what belongs in Impacts              | Classify by kind of evidence (signal, linked, event, adaptation), not by whether climate change caused the event.                                      | Decided                  |
| 2026-09-28 | Disaster side stories (fundraisers, arrests)       | Out.                                                                                                                                                   | Decided                  |
| 2026-09-28 | Biodiversity and conservation                      | In only when the text ties it directly to climate change, such as a species lost to warming. That makes it a `linked` story.                           | Decided                  |
| 2026-09-28 | Source quality                                     | A strong outlet's story matters more than a clickbait piece on the same subject. Quality is judged from the source, not from the topic. See section 8. | Decided                  |

### Batch 1 labels the rulings would change

| Title                                                                         | Labelled                    | Under the rulings                                   |
| ----------------------------------------------------------------------------- | --------------------------- | --------------------------------------------------- |
| Southeast Wisconsin Weather: Heavy rain brings flooding concerns this weekend | climate yes                 | climate no (forecast)                               |
| Flash Flood Warning in Effect in Greenwich                                    | climate yes                 | climate no (warning)                                |
| Track where a potent nor'easter will bring heavy rain                         | climate yes                 | climate no (tracker), type `not_news`               |
| Flooding in Otter Tail County                                                 | climate yes                 | climate no (no sign of scale)                       |
| States Are Opening the Door to Data Center Investment in Virtual Power Plants | climate no                  | climate yes, government, secondary tech             |
| Oil Cos. Escape Mich. Climate Change Antitrust Suit                           | business, secondary justice | government, secondary business (brought by a state) |

## 8. Topic and source quality

The rubric answers one question: is this article on topic? It does not judge how good the article is.

Quality is a separate question, and the source answers most of it. An in-depth New York Times piece on a species lost to warming and a content-farm post on the same animal are both on topic. Only one deserves a lead position.

| Question                   | Decided by             | Where                                        |
| -------------------------- | ---------------------- | -------------------------------------------- |
| Is it on topic?            | This rubric            | Labels, and the models in `categorize:eval`  |
| Is the source trustworthy? | Source weight, 1 to 10 | `config/sourceTiers.ts`                      |
| Can it lead a cluster?     | Lead eligibility       | `LEAD_INELIGIBLE_SQL` in `lib/clustering.ts` |
| Is it an article at all?   | Article type           | Section 5                                    |

Do not loosen or tighten a topic call because of who published it. Label the topic, and let the source weight decide how prominent the article is.
