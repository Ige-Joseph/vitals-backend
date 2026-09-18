# Clinical sources

Authoritative documents behind every clinical schedule in this codebase.

The ANC contact weeks and the baby vaccination schedule are not developer
decisions. They come from published guidance, and this folder is where that
guidance lives so the question "according to which standard?" always has an
answer.

## Rules

1. **Nothing in a clinical schedule constant changes without a source in this
   folder.** Not from memory, not from a health blog, not from an LLM. If a
   change can't be traced to a file here, it doesn't ship.
2. **Every schedule entry in code cites its row in the manifest below**, via
   the `source` key in its provenance block.
3. **Dated files are snapshots.** Re-download and add a new dated file rather
   than overwriting. The old one is the record of what we built against.
4. **Clinical review is required** before any schedule change reaches users.
   A diff against these documents is what gets reviewed — not the code.

---

## Fetching the sources

Run from `vitals-backend/` — the repository root, and the project whose
`src/config/pregnancy.config.ts` these documents govern. Nine of the ten files
download directly; one needs a browser.

```bash
mkdir -p docs/clinical-sources/anc docs/clinical-sources/immunization

# WHO ANC guideline 2016 (3.7 MB) — the 8-contact model itself
curl -L -o docs/clinical-sources/anc/who-anc-guideline-2016.pdf \
  "https://iris.who.int/server/api/core/bitstreams/9dccde13-3593-4a22-9237-61abe5a3c6b7/content"

# WHO ANC Digital Adaptation Kit 2021 (2.7 MB) — software-neutral spec for
# digital ANC systems: workflows, data elements, decision support
curl -L -o docs/clinical-sources/anc/who-anc-dak-2021.pdf \
  "https://iris.who.int/server/api/core/bitstreams/0affb504-e80a-42db-9b53-7c442d4c72f2/content"

# DAK annexes — the machine-readable parts.
#
# NOTE: the old `apps.who.int/iris/bitstream/handle/...` URLs no longer serve
# files. IRIS migrated to DSpace 7 and those handles now redirect to an HTML
# landing page, so curl writes a ~755-byte error document carrying an .xlsx
# name — exactly the trap the verify step below exists to catch. These are the
# current bitstream endpoints.
curl -L -o docs/clinical-sources/anc/who-anc-dak-annex-a-data-dictionary.xlsx \
  "https://iris.who.int/server/api/core/bitstreams/affcde61-7176-45c5-aac9-5503d2efc74d/content"
curl -L -o docs/clinical-sources/anc/who-anc-dak-annex-b-decision-support.xlsx \
  "https://iris.who.int/server/api/core/bitstreams/e8520d08-bb73-451f-b042-00858b1c1f0f/content"
curl -L -o docs/clinical-sources/anc/who-anc-dak-annex-c-indicators.xlsx \
  "https://iris.who.int/server/api/core/bitstreams/6597134f-d105-498e-a423-b5a2d526d8e2/content"
curl -L -o docs/clinical-sources/anc/who-anc-dak-annex-d-functional-requirements.xlsx \
  "https://iris.who.int/server/api/core/bitstreams/e6a3be63-3945-4ca3-9608-922dafe67f36/content"

# The 2022 ultrasound guideline update — normative, supersedes the 2016
# ultrasound recommendation.
curl -L -o docs/clinical-sources/anc/who-anc-2022-ultrasound-guideline-update.pdf \
  "https://iris.who.int/server/api/core/bitstreams/5924dc9d-d46e-4549-b0d6-bbe00b38d159/content"

# The companion Technical Brief — implementation context, NOT normative.
# Kept so nobody re-downloads it later thinking it is the guideline.
curl -L -o docs/clinical-sources/anc/who-anc-2022-ultrasound-technical-brief.pdf \
  "https://iris.who.int/server/api/core/bitstreams/6549aec3-998c-4410-9a5c-ef544a2049c7/content"

# Paediatric Association of Nigeria — plain HTML, curl works.
curl -L -o "docs/clinical-sources/immunization/pan-nigeria-schedule-$(date +%F).html" \
  "https://pan-ng.org/immunization-page/"
```

If an IRIS URL 404s in future, resolve the current one from its handle rather
than guessing:

```bash
curl -sL -H "Accept: application/json" \
  "https://iris.who.int/server/api/pid/find?id=hdl:10665/339740"
# then follow _links.bundles -> bitstreams for the live bitstream uuid
```

Verify — anything only a few hundred bytes is an error page, not a document.
Check the type as well as the size, because an error page takes whatever
filename you gave it:

```bash
ls -la docs/clinical-sources/anc docs/clinical-sources/immunization
file docs/clinical-sources/anc/* docs/clinical-sources/immunization/*
```

Every `.xlsx` must report `Microsoft Excel 2007+` and every `.pdf` must report
`PDF document`. Anything reporting `HTML document` is a failed download.

### The manual one

**WHO Nigeria vaccination schedule.** The table is rendered client-side, so
curl returns an empty shell. Open in a browser and print to PDF:

    https://immunizationdata.who.int/global/wiise-detail-page/vaccination-schedule-for-country_name?ISO_3_CODE=NGA

    → docs/clinical-sources/immunization/who-nigeria-schedule-YYYY-MM-DD.pdf

**Paediatric Association of Nigeria schedule.** Confirmed working with curl —
it is in the fetch block above and needs no manual step. Saved as `.html`,
which the rules permit.

    https://pan-ng.org/immunization-page/

    → docs/clinical-sources/immunization/pan-nigeria-schedule-YYYY-MM-DD.html

Note: `nphcda.gov.ng` blocks automated access entirely. The WHO immunisation
portal is the citable route to the same national schedule, since it publishes
what Nigeria officially reports through the WHO/UNICEF Joint Reporting Form.

### Guideline updates — don't stop at the base document

The 2016 ANC guideline has had published updates that supersede parts of it.
The one that matters here is the 2022 maternal and fetal assessment update on
ultrasound before 24 weeks:

    https://www.who.int/publications/i/item/9789240046009

That is one document, and the title on its own cover page reads "Maternal and
fetal assessment update: imaging ultrasound before 24 weeks of pregnancy" — so
both halves of that description name the same publication. An earlier edit to
this file claimed they were two and was wrong; the PDFs were opened and the
claim retracted.

There is a **second, non-normative** publication that is easy to mistake for
it. WHO lists it under "Highlights and key messages" rather than "Guideline
updates", and its own cover says **Technical Brief**:

    Imaging ultrasound before 24 weeks of pregnancy — Technical Brief
    ISBN 9789240051461, 8 pages
    https://www.who.int/publications/i/item/9789240051461

It restates the recommendation in a box and then covers implementation:
national policy, financing, equipment, health-worker training. It is useful
context and it is **not** a source a clinical constant may cite. Both are
fetched above; only the guideline update is normative.

Others (nutritional: zinc 2021, multiple micronutrients 2020, vitamin D 2020)
are listed on the guideline's landing page. Add any you download as their own
manifest row. The base guideline alone is not the current position.

---

## Manifest

Retrieval dates below are real. A row with **OUTSTANDING** in place of a
date means the file is not yet in the folder, and nothing may cite it.

| File | Title | Publisher | Version / published | Retrieved | Governs |
|---|---|---|---|---|---|
| `anc/who-anc-guideline-2016.pdf` | WHO recommendations on antenatal care for a positive pregnancy experience | WHO | 2016 (ISBN 9789241549912) | 2026-09-05 | ANC contact weeks |
| `anc/who-anc-2022-ultrasound-guideline-update.pdf` | WHO antenatal care recommendations for a positive pregnancy experience. Maternal and fetal assessment update: imaging ultrasound before 24 weeks of pregnancy (**normative guideline update**, 43 pp, GRADE tables) | WHO | 2022 (ISBN 9789240046009) | 2026-09-05 | Supersedes the 2016 ultrasound recommendation. **No Vitals constant traced to it yet — see Open decisions.** |
| `anc/who-anc-2022-ultrasound-technical-brief.pdf` | Imaging ultrasound before 24 weeks of pregnancy: 2022 update to the WHO ANC recommendations (**Technical Brief**, 8 pp, implementation considerations) | WHO | 2022 (ISBN 9789240051461) | 2026-09-05 | **Nothing — reference only. Not citable by a clinical constant.** |
| `anc/who-anc-dak-2021.pdf` | Digital Adaptation Kit for Antenatal Care | WHO | 17 Feb 2021 (ISBN 978 92 4 002030 6) | 2026-09-05 | ANC data model, workflow, decision support |
| `anc/who-anc-dak-annex-a-data-dictionary.xlsx` | DAK Web annex A: core data dictionary | WHO | 2021 (WHO-SRH-21.1) | 2026-09-05 | ANC data elements |
| `anc/who-anc-dak-annex-b-decision-support.xlsx` | DAK Web annex B: decision support logic | WHO | 2021 (WHO-SRH-21.2) | 2026-09-05 | ANC decision logic |
| `anc/who-anc-dak-annex-c-indicators.xlsx` | DAK Web annex C: indicator table | WHO | 2021 (WHO-SRH-21.3) | 2026-09-05 | ANC programme indicators |
| `anc/who-anc-dak-annex-d-functional-requirements.xlsx` | DAK Web annex D: functional and non-functional requirements | WHO | 2021 (WHO-SRH-21.4) | 2026-09-05 | ANC system requirements |
| `immunization/who-nigeria-schedule-YYYY-MM-DD.pdf` | Vaccination schedule for Nigeria | WHO Immunization Data portal (official reporting via WHO/UNICEF JRF) | as-reported snapshot | **OUTSTANDING** | Routine Nigerian NPI schedule |
| `immunization/pan-nigeria-schedule-2026-09-05.html` | Immunization Page | Paediatric Association of Nigeria | page revision at retrieval | 2026-09-05 | Supplemental / optional Nigerian vaccines |

Landing pages, for provenance and for finding newer editions:

- WHO ANC guideline — https://www.who.int/publications/i/item/9789241549912
- WHO ANC Digital Adaptation Kit — https://www.who.int/publications/i/item/9789240020306
- WHO ANC 2022 ultrasound update — https://www.who.int/publications/i/item/9789240046009
- WHO Nigeria vaccination schedule — https://immunizationdata.who.int/global/wiise-detail-page/vaccination-schedule-for-country_name?ISO_3_CODE=NGA
- Paediatric Association of Nigeria — https://pan-ng.org/immunization-page/
- WHO Postnatal Care DAK (not yet used) — https://www.who.int/publications/i/item/9789240090347

WHO material here is CC BY-NC-SA 3.0 IGO. Stored for internal reference.

---

## Open decisions

### Does the 2022 ultrasound update govern the week-20 constant?

**Unresolved. Needs Joseph.**

The recommendation is *"one ultrasound scan before 24 weeks of gestation … to
estimate gestational age, improve detection of fetal anomalies and multiple
pregnancies, reduce induction of labour for post-term pregnancy, and improve a
woman's pregnancy experience."* It specifies a **window**, not a week.

Two constants sit inside that window:

- `ANC_MILESTONES` week 20 — `title: 'Anomaly Scan'`, `eventType: 'ANC_SCAN'`
- `WEEKLY_GUIDANCE` [14, 26] — tip `'Attend your anomaly scan at 20 weeks'`

Both are *consistent with* the recommendation. Neither is *derived from* it:
WHO names no week, and "anomaly scan at 20 weeks" is the UK NICE convention
(18+0–20+6). The config also narrows the stated purpose to anomaly detection,
dropping gestational-age estimation — which is the purpose WHO lists first.

So the honest status is that the document is in scope but governs nothing yet.
Per the rule against assigning a `governs` role merely because a
recommendation is clinically relevant, the manifest row says so rather than
claiming otherwise. Resolving it is a clinical-review question, not a
documentation one.

### Vaccination schedule scope


The vaccination schedule can represent either:

- **A — routine NPI only.** Everything listed is free at government
  facilities. Optional private-market vaccines are excluded entirely.
- **B — broader Nigerian childhood schedule.** Routine NPI plus
  PAN-recommended optional vaccines, each clearly labelled with its
  availability and cost.

These give different correct answers for the same entries. Under A, hepatitis A
and varicella are errors. Under B they are legitimate but must not be presented
as free or routine.

**Not yet decided.** Until it is, no vaccine is added or removed.

## Provenance block format

Every clinical schedule constant carries this. Proposed shape — adjust to match
the eventual comparison report:

```ts
/**
 * @source        who-nigeria-schedule-YYYY-MM-DD
 * @sourceVersion as-reported snapshot, retrieved YYYY-MM-DD
 * @locale        NG
 * @reviewedBy    <clinician name / role>
 * @reviewedOn    YYYY-MM-DD
 * @status        routine | supplemental
 */
```

`status` is the field that keeps a private-market vaccine from being displayed
as if it were free at a PHC. It is not cosmetic.

## Review cadence

Re-check against source at least annually, and after any announced national
schedule change. Nigeria has changed this schedule three times recently —
rotavirus (2022), HPV (2023), R21 malaria (2024) — so drift is the default
state, not the exception.

| Last reviewed | By | Outcome |
|---|---|---|
| 2026-09-05 | — (sources fetched, not clinically reviewed) | 9 of 10 sources retrieved. WHO Nigeria schedule outstanding. No schedule constant changed. |
