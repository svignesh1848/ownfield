// Entry: load the chosen language (and its font) first, then the app, so every t() call — including
// module-level labels — sees the right dictionary.
import { initI18n } from "./i18n";
initI18n().finally(() => import("./main"));
