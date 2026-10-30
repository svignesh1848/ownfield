# Translations

English is the source: the English text itself is the key (`t("Save")`), so any text without a translation simply shows in English.
`en.json` lists every user-facing string in the app (plus the user-facing server error messages, which the app translates when it shows them).
Each language is `<code>.json` and is downloaded only when chosen, together with its Noto font (self-hosted, one script per language).

Write in simple, everyday business words. Keep product and brand terms as they are: GST, GSTIN, SKU, MRP, UPI, NEFT, PO, QR, WhatsApp, SMS, OwnField.
`{0}`, `{1}` are filled in by the app — keep them. A test (`server/test/i18n.test.ts`) checks keys, placeholders and the English fallback.

## Status

**Native speakers: please review.** No translation below has had native-speaker review yet; most strings were machine-assisted (brand and terms like GST kept as they are), so some wording may be stiff. Bodo and Kashmiri cover only the main screens so far. Corrections are very welcome — open a pull request editing the JSON file.

| Language | Code | Direction | Strings translated | Status |
|---|---|---|---|---|
| Assamese · অসমীয়া | `as` | LTR | 1254 / 1254 (100%) | complete, needs native review |
| Bengali · বাংলা | `bn` | LTR | 1254 / 1254 (100%) | complete, needs native review |
| Bodo · बड़ो | `brx` | LTR | 137 / 1254 (11%) | in progress — help wanted |
| Dogri · डोगरी | `doi` | LTR | 1254 / 1254 (100%) | complete, needs native review |
| Gujarati · ગુજરાતી | `gu` | LTR | 1254 / 1254 (100%) | complete, needs native review |
| Hindi · हिन्दी | `hi` | LTR | 1254 / 1254 (100%) | complete, needs native review |
| Kannada · ಕನ್ನಡ | `kn` | LTR | 1254 / 1254 (100%) | complete, needs native review |
| Kashmiri · کٲشُر | `ks` | RTL | 137 / 1254 (11%) | in progress — help wanted |
| Konkani · कोंकणी | `kok` | LTR | 1254 / 1254 (100%) | complete, needs native review |
| Maithili · मैथिली | `mai` | LTR | 1254 / 1254 (100%) | complete, needs native review |
| Malayalam · മലയാളം | `ml` | LTR | 1254 / 1254 (100%) | complete, needs native review |
| Manipuri (Meitei) · ꯃꯤꯇꯩꯂꯣꯟ | `mni` | LTR | 1254 / 1254 (100%) | complete, needs native review |
| Marathi · मराठी | `mr` | LTR | 1254 / 1254 (100%) | complete, needs native review |
| Nepali · नेपाली | `ne` | LTR | 1254 / 1254 (100%) | complete, needs native review |
| Odia · ଓଡ଼ିଆ | `or` | LTR | 1254 / 1254 (100%) | complete, needs native review |
| Punjabi · ਪੰਜਾਬੀ | `pa` | LTR | 1254 / 1254 (100%) | complete, needs native review |
| Sanskrit · संस्कृतम् | `sa` | LTR | 1254 / 1254 (100%) | complete, needs native review |
| Santali · ᱥᱟᱱᱛᱟᱲᱤ | `sat` | LTR | 1254 / 1254 (100%) | complete, needs native review |
| Sindhi · سنڌي | `sd` | RTL | 1254 / 1254 (100%) | complete, needs native review |
| Tamil · தமிழ் | `ta` | LTR | 1254 / 1254 (100%) | complete, needs native review |
| Telugu · తెలుగు | `te` | LTR | 1254 / 1254 (100%) | complete, needs native review |
| Urdu · اردو | `ur` | RTL | 1254 / 1254 (100%) | complete, needs native review |

Untranslated strings show in English. A test checks that every language has every key (Bodo and Kashmiri are listed as in progress).
