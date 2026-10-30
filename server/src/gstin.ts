// Indian GST / business identifier helpers (shared by server and web — keep dependency-free).
export const GST_STATES: Record<string, string> = {
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand", "06": "Haryana", "07": "Delhi",
  "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur",
  "15": "Mizoram", "16": "Tripura", "17": "Meghalaya", "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh",
  "23": "Madhya Pradesh", "24": "Gujarat", "25": "Daman and Diu", "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra",
  "28": "Andhra Pradesh (old)", "29": "Karnataka", "30": "Goa", "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry",
  "35": "Andaman and Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh", "97": "Other Territory", "99": "Centre Jurisdiction",
};
const CH = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** GSTIN check character (mod-36 Luhn variant used by GSTN). */
export function gstinCheckChar(first14: string) {
  let sum = 0;
  for (let i = 0; i < 14; i++) { const p = CH.indexOf(first14[i]) * (i % 2 ? 2 : 1); sum += Math.floor(p / 36) + (p % 36); }
  return CH[(36 - (sum % 36)) % 36];
}
export const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
/** Returns an error message, or "" when the GSTIN is valid. */
export function gstinError(g: string) {
  if (!/^[0-9A-Z]{15}$/.test(g)) return "GSTIN must be 15 letters/digits";
  if (!GST_STATES[g.slice(0, 2)]) return "GSTIN starts with an unknown state code";
  if (!GSTIN_RE.test(g)) return "GSTIN format is invalid (2-digit state + 10-char PAN + entity no. + Z + check)";
  if (gstinCheckChar(g.slice(0, 14)) !== g[14]) return "GSTIN check digit is wrong — please re-check the number";
  return "";
}
export const gstinInfo = (g: string) => ({ stateCode: g.slice(0, 2), state: GST_STATES[g.slice(0, 2)] || "", pan: g.slice(2, 12) });
export const ID_RULES: Record<string, [RegExp, string]> = {
  pan: [/^[A-Z]{5}\d{4}[A-Z]$/, "PAN must look like ABCDE1234F"],
  tan: [/^[A-Z]{4}\d{5}[A-Z]$/, "TAN must look like ABCD12345E"],
  cin: [/^([LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}|[A-Z]{3}-\d{4})$/, "CIN must be 21 characters (e.g. U12345TN2020PTC123456) or LLPIN like AAB-1234"],
  udyam: [/^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/, "Udyam no. must look like UDYAM-TN-01-0001234"],
  ifsc: [/^[A-Z]{4}0[A-Z0-9]{6}$/, "IFSC must look like HDFC0001234"],
  upi: [/^[\w.-]{2,256}@[a-zA-Z]{2,64}$/, "UPI ID must look like name@bank"],
  pincode: [/^[1-9]\d{5}$/, "PIN code must be 6 digits"],
  email: [/^[^@\s]+@[^@\s]+\.[^@\s]+$/, "invalid email"],
  phone: [/^\+?[\d\s-]{8,15}$/, "invalid phone"],
  account: [/^\d{9,18}$/, "bank account no. must be 9–18 digits"],
};
