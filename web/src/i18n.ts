// Tiny i18n: English is the source; Hindi, Tamil and Kannada have starter strings. Missing keys fall back to English.
// Add a language by adding a dictionary here. The choice is stored on the phone (localStorage "ff-lang").
export const LANGS: Record<string, string> = { en: "English", hi: "हिन्दी", ta: "தமிழ்", kn: "ಕನ್ನಡ" };
const D: Record<string, Record<string, string>> = {
  hi: { home: "होम", beat: "आज की बीट", order: "नया ऑर्डर", orders: "ऑर्डर", collect: "वसूली", targets: "लक्ष्य", catalog: "उत्पाद", inbox: "नए ऑर्डर", invoices: "बिल",
    collections: "वसूली", stock: "स्टॉक", profile: "मेरी प्रोफ़ाइल", dashboard: "टीम गतिविधि", beats: "बीट योजना", visits: "विज़िट", reports: "रिपोर्ट", shops: "दुकानें", schemes: "ऑफ़र और स्कीम",
    distributors: "वितरक", users: "उपयोगकर्ता", settings: "कंपनी सेटिंग्स", import: "डेटा अपलोड", security: "सुरक्षा और गोपनीयता", integrations: "इंटीग्रेशन", account: "मेरा खाता", more: "और",
    van: "मेरी वैन", vans: "वैन बिक्री", inventory: "इन्वेंटरी", claims: "क्लेम", leads: "लीड्स", trail: "लोकेशन ट्रेल", coverage: "कवरेज", surveys: "सर्वे", survey: "सर्वे भरें", messages: "संदेश",
    language: "भाषा", offline: "ऑफ़लाइन", online: "ऑनलाइन", waiting: "सिंक होने का इंतज़ार", save: "सेव करें", scan: "स्कैन", search: "खोजें", sell: "बेचें", load_van: "वैन लोड करें", close_day: "दिन बंद करें" },
  ta: { home: "முகப்பு", beat: "இன்றைய பீட்", order: "புதிய ஆர்டர்", orders: "ஆர்டர்கள்", collect: "வசூல்", targets: "இலக்குகள்", catalog: "பொருட்கள்", inbox: "புதிய ஆர்டர்கள்", invoices: "பில்கள்",
    collections: "வசூல்", stock: "இருப்பு", profile: "என் சுயவிவரம்", dashboard: "குழு செயல்பாடு", beats: "பீட் திட்டம்", visits: "வருகைகள்", reports: "அறிக்கைகள்", shops: "கடைகள்", schemes: "சலுகைகள்",
    distributors: "விநியோகஸ்தர்கள்", users: "பயனர்கள்", settings: "நிறுவன அமைப்புகள்", import: "தரவு பதிவேற்றம்", security: "பாதுகாப்பு", integrations: "ஒருங்கிணைப்புகள்", account: "என் கணக்கு", more: "மேலும்",
    van: "என் வேன்", vans: "வேன் விற்பனை", inventory: "சரக்கு", claims: "கோரிக்கைகள்", leads: "லீட்கள்", trail: "இருப்பிடப் பாதை", coverage: "கவரேஜ்", surveys: "கணக்கெடுப்புகள்", survey: "கணக்கெடுப்பு", messages: "செய்திகள்",
    language: "மொழி", offline: "ஆஃப்லைன்", online: "ஆன்லைன்", waiting: "ஒத்திசைக்க காத்திருக்கிறது", save: "சேமி", scan: "ஸ்கேன்", search: "தேடு", sell: "விற்பனை", load_van: "வேனை ஏற்று", close_day: "நாளை முடி" },
  kn: { home: "ಮುಖಪುಟ", beat: "ಇಂದಿನ ಬೀಟ್", order: "ಹೊಸ ಆರ್ಡರ್", orders: "ಆರ್ಡರ್‌ಗಳು", collect: "ವಸೂಲಿ", targets: "ಗುರಿಗಳು", catalog: "ಉತ್ಪನ್ನಗಳು", inbox: "ಹೊಸ ಆರ್ಡರ್‌ಗಳು", invoices: "ಬಿಲ್‌ಗಳು",
    collections: "ವಸೂಲಿ", stock: "ದಾಸ್ತಾನು", profile: "ನನ್ನ ಪ್ರೊಫೈಲ್", dashboard: "ತಂಡದ ಚಟುವಟಿಕೆ", beats: "ಬೀಟ್ ಯೋಜನೆ", visits: "ಭೇಟಿಗಳು", reports: "ವರದಿಗಳು", shops: "ಅಂಗಡಿಗಳು", schemes: "ಆಫರ್‌ಗಳು",
    distributors: "ವಿತರಕರು", users: "ಬಳಕೆದಾರರು", settings: "ಕಂಪನಿ ಸೆಟ್ಟಿಂಗ್ಸ್", import: "ಡೇಟಾ ಅಪ್‌ಲೋಡ್", security: "ಭದ್ರತೆ", integrations: "ಏಕೀಕರಣಗಳು", account: "ನನ್ನ ಖಾತೆ", more: "ಇನ್ನಷ್ಟು",
    van: "ನನ್ನ ವ್ಯಾನ್", vans: "ವ್ಯಾನ್ ಮಾರಾಟ", inventory: "ಇನ್ವೆಂಟರಿ", claims: "ಕ್ಲೈಮ್‌ಗಳು", leads: "ಲೀಡ್‌ಗಳು", trail: "ಸ್ಥಳ ಹಾದಿ", coverage: "ಕವರೇಜ್", surveys: "ಸಮೀಕ್ಷೆಗಳು", survey: "ಸಮೀಕ್ಷೆ", messages: "ಸಂದೇಶಗಳು",
    language: "ಭಾಷೆ", offline: "ಆಫ್‌ಲೈನ್", online: "ಆನ್‌ಲೈನ್", waiting: "ಸಿಂಕ್‌ಗಾಗಿ ಕಾಯುತ್ತಿದೆ", save: "ಉಳಿಸಿ", scan: "ಸ್ಕ್ಯಾನ್", search: "ಹುಡುಕಿ", sell: "ಮಾರಾಟ", load_van: "ವ್ಯಾನ್ ತುಂಬಿಸಿ", close_day: "ದಿನ ಮುಚ್ಚಿ" },
};
export const lang = () => localStorage.getItem("ff-lang") || "en";
export const setLang = (l: string) => { localStorage.setItem("ff-lang", l); document.documentElement.lang = l; location.reload(); };
/** Translate a key; English text is the fallback. */
export const t = (key: string, en?: string) => D[lang()]?.[key] ?? en ?? key;
