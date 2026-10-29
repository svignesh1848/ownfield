# Translations

English is the source: the English text itself is the key (`t("Save")`), so any text without a translation simply shows in English.
`en.json` lists every user-facing string in the app (plus the user-facing server error messages, which the app translates when it shows them).
Each language is `<code>.json` and is downloaded only when chosen, together with its Noto font (self-hosted, one script per language).

Write in simple, everyday business words. Keep product and brand terms as they are: GST, GSTIN, SKU, MRP, UPI, NEFT, PO, QR, WhatsApp, SMS, FieldForce.
`{0}`, `{1}` are filled in by the app — keep them. A test (`server/test/i18n.test.ts`) checks keys, placeholders and the English fallback.

## Status

**Native speakers: please review.** Every translation below was written without native-speaker review. Languages marked **beta** are the least reviewed (and *starter* ones cover only the main menu and sign-in words) — corrections and missing strings are very welcome; open a pull request editing the JSON file.

| Language | Code | Direction | Strings translated | Status |
|---|---|---|---|---|
| Assamese · অসমীয়া | `as` | LTR | 137 / 974 (14%) | beta |
| Bengali · বাংলা | `bn` | LTR | 137 / 974 (14%) | needs native review |
| Bodo · बड़ो | `brx` | LTR | 137 / 974 (14%) | beta |
| Dogri · डोगरी | `doi` | LTR | 137 / 974 (14%) | beta |
| Gujarati · ગુજરાતી | `gu` | LTR | 137 / 974 (14%) | needs native review |
| Hindi · हिन्दी | `hi` | LTR | 476 / 974 (49%) | needs native review |
| Kannada · ಕನ್ನಡ | `kn` | LTR | 137 / 974 (14%) | needs native review |
| Kashmiri · کٲشُر | `ks` | RTL | 137 / 974 (14%) | beta |
| Konkani · कोंकणी | `kok` | LTR | 137 / 974 (14%) | beta |
| Maithili · मैथिली | `mai` | LTR | 137 / 974 (14%) | beta |
| Malayalam · മലയാളം | `ml` | LTR | 137 / 974 (14%) | needs native review |
| Manipuri (Meitei) · ꯃꯤꯇꯩꯂꯣꯟ | `mni` | LTR | 44 / 974 (5%) | beta (starter) |
| Marathi · मराठी | `mr` | LTR | 137 / 974 (14%) | needs native review |
| Nepali · नेपाली | `ne` | LTR | 137 / 974 (14%) | beta |
| Odia · ଓଡ଼ିଆ | `or` | LTR | 137 / 974 (14%) | beta |
| Punjabi · ਪੰਜਾਬੀ | `pa` | LTR | 137 / 974 (14%) | needs native review |
| Sanskrit · संस्कृतम् | `sa` | LTR | 137 / 974 (14%) | beta |
| Santali · ᱥᱟᱱᱛᱟᱲᱤ | `sat` | LTR | 43 / 974 (4%) | beta (starter) |
| Sindhi · سنڌي | `sd` | RTL | 137 / 974 (14%) | beta |
| Tamil · தமிழ் | `ta` | LTR | 137 / 974 (14%) | needs native review |
| Telugu · తెలుగు | `te` | LTR | 137 / 974 (14%) | needs native review |
| Urdu · اردو | `ur` | RTL | 173 / 974 (18%) | needs native review |

Untranslated strings show in English. The menus, sign-in screen, common buttons and order/visit actions are covered first; long help texts and admin screens are mostly still English.
