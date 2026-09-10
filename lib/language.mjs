// Which language a turn is answered in, and where that decision comes from.
//
// Until September 2026 nothing in the harness knew what language the user wrote
// in. The synthesiser answered in English unless the question happened to say
// otherwise, so a Persian question written in Latin letters got an English
// clarification, a Hungarian question was answered in Hungarian only because it
// ended "válaszolj magyarul", and "can you reply in persian?" was treated as a
// fresh question ("yes, I can — how can I help?") rather than as an instruction
// about the answer it had just given.
//
// The language is decided HERE, once per turn, from three inputs, and everything
// downstream reads the decision rather than re-deriving it:
//
//   1. An explicit request ("reply in Persian", "válaszolj magyarul") PINS the
//      conversation: every later turn is answered in that language until the
//      user asks for another. That is the literal reading of the request, and it
//      is what keeps a user who types English term names but reads Persian from
//      being flipped back to English by their own vocabulary.
//   2. Otherwise a TYPED turn is answered in the language it was typed in, as
//      the planner read it. The planner already runs a JSON call on every typed
//      question that is not a template match, so this costs nothing.
//   3. A CLICKED follow-on chip carries an English query the user did not write,
//      so it inherits the language of the conversation rather than of the chip.
//      The deterministic typed paths (fast path, template, context chip) only
//      match English syntax, so they are English turns.
//
// Codes are BCP-47 primary subtags (ISO 639-1 where one exists), lower case. The
// planner is asked for a code but may answer with a name; both are accepted.

const NAME_TO_CODE = Object.freeze({
  english: 'en', persian: 'fa', farsi: 'fa', hungarian: 'hu', magyar: 'hu', german: 'de', deutsch: 'de',
  french: 'fr', français: 'fr', francais: 'fr', spanish: 'es', español: 'es', espanol: 'es', castilian: 'es',
  portuguese: 'pt', português: 'pt', italian: 'it', italiano: 'it', dutch: 'nl', nederlands: 'nl',
  polish: 'pl', polski: 'pl', czech: 'cs', slovak: 'sk', romanian: 'ro', greek: 'el', turkish: 'tr', türkçe: 'tr',
  russian: 'ru', ukrainian: 'uk', bulgarian: 'bg', serbian: 'sr', croatian: 'hr', slovenian: 'sl',
  swedish: 'sv', norwegian: 'no', danish: 'da', finnish: 'fi', estonian: 'et', latvian: 'lv', lithuanian: 'lt',
  hebrew: 'he', arabic: 'ar', urdu: 'ur', hindi: 'hi', bengali: 'bn', tamil: 'ta', telugu: 'te', marathi: 'mr',
  gujarati: 'gu', punjabi: 'pa', chinese: 'zh', mandarin: 'zh', cantonese: 'zh', japanese: 'ja', korean: 'ko',
  vietnamese: 'vi', thai: 'th', indonesian: 'id', malay: 'ms', filipino: 'tl', tagalog: 'tl', swahili: 'sw',
  catalan: 'ca', basque: 'eu', galician: 'gl', welsh: 'cy', irish: 'ga', gaelic: 'gd', icelandic: 'is',
  afrikaans: 'af', georgian: 'ka', armenian: 'hy', azerbaijani: 'az', kazakh: 'kk', uzbek: 'uz', mongolian: 'mn',
  nepali: 'ne', sinhala: 'si', burmese: 'my', khmer: 'km', lao: 'lo', amharic: 'am', somali: 'so', hausa: 'ha',
  yoruba: 'yo', igbo: 'ig', zulu: 'zu', xhosa: 'xh', albanian: 'sq', macedonian: 'mk', bosnian: 'bs',
  belarusian: 'be', maltese: 'mt', luxembourgish: 'lb', esperanto: 'eo', latin: 'la', kurdish: 'ku', pashto: 'ps',
  dari: 'fa', tajik: 'tg', malayalam: 'ml', kannada: 'kn', odia: 'or', assamese: 'as'
})

// English names for the prompt that asks for the translation. A code the table
// does not know is passed to the model as the code itself, which every model
// this runs on reads correctly ("answer in fa" is understood; it is just less
// natural than "answer in Persian").
const CODE_TO_NAME = Object.freeze({
  en: 'English', fa: 'Persian', hu: 'Hungarian', de: 'German', fr: 'French', es: 'Spanish', pt: 'Portuguese',
  it: 'Italian', nl: 'Dutch', pl: 'Polish', cs: 'Czech', sk: 'Slovak', ro: 'Romanian', el: 'Greek', tr: 'Turkish',
  ru: 'Russian', uk: 'Ukrainian', bg: 'Bulgarian', sr: 'Serbian', hr: 'Croatian', sl: 'Slovenian', sv: 'Swedish',
  no: 'Norwegian', da: 'Danish', fi: 'Finnish', et: 'Estonian', lv: 'Latvian', lt: 'Lithuanian', he: 'Hebrew',
  ar: 'Arabic', ur: 'Urdu', hi: 'Hindi', bn: 'Bengali', ta: 'Tamil', te: 'Telugu', mr: 'Marathi', gu: 'Gujarati',
  pa: 'Punjabi', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', vi: 'Vietnamese', th: 'Thai', id: 'Indonesian',
  ms: 'Malay', tl: 'Filipino', sw: 'Swahili', ca: 'Catalan', eu: 'Basque', gl: 'Galician', cy: 'Welsh', ga: 'Irish',
  gd: 'Scottish Gaelic', is: 'Icelandic', af: 'Afrikaans', ka: 'Georgian', hy: 'Armenian', az: 'Azerbaijani',
  kk: 'Kazakh', uz: 'Uzbek', mn: 'Mongolian', ne: 'Nepali', si: 'Sinhala', my: 'Burmese', km: 'Khmer', lo: 'Lao',
  am: 'Amharic', so: 'Somali', ha: 'Hausa', yo: 'Yoruba', ig: 'Igbo', zu: 'Zulu', xh: 'Xhosa', sq: 'Albanian',
  mk: 'Macedonian', bs: 'Bosnian', be: 'Belarusian', mt: 'Maltese', lb: 'Luxembourgish', eo: 'Esperanto',
  la: 'Latin', ku: 'Kurdish', ps: 'Pashto', tg: 'Tajik', ml: 'Malayalam', kn: 'Kannada', or: 'Odia', as: 'Assamese'
})

// Scripts written right to left. Only used to choose the fallback note's
// direction hint; the client aligns every message with dir="auto" regardless.
const RTL = new Set(['fa', 'ar', 'he', 'ur', 'ps', 'ku', 'sd', 'yi', 'ug', 'dv'])

/**
 * Normalise whatever the planner (or a client) wrote for a language into a
 * lower-case primary subtag, or '' when it is not one.
 *
 *   'fa' -> 'fa'   'fa-IR' -> 'fa'   'Persian' -> 'fa'   'Farsi (Latin)' -> 'fa'
 *   'zh-Hant' -> 'zh'   '' -> ''   'gibberish' -> ''
 */
export function normaliseLanguageCode(raw) {
  if (typeof raw !== 'string') return ''
  const s = raw.trim().toLowerCase()
  if (!s) return ''
  const tag = s.split(/[-_\s(]/)[0]
  // Any ISO 639 alpha code, whether or not the name table knows it: the
  // tables here are conveniences for prompts, not a list of supported
  // languages. There is no such list — the model translates into whatever it
  // was asked for and the check decides whether that shipped.
  if (/^[a-z]{2,3}$/.test(tag)) return tag
  const byName = NAME_TO_CODE[s] || NAME_TO_CODE[tag]
  return byName || ''
}

/** English display name for a code, for prompts ("translate into Persian"). */
export function languageName(code) {
  const c = normaliseLanguageCode(code)
  return CODE_TO_NAME[c] || c || 'English'
}

export function isEnglish(code) {
  const c = normaliseLanguageCode(code)
  return !c || c === 'en'
}

export function isRightToLeft(code) {
  return RTL.has(normaliseLanguageCode(code))
}

/**
 * Validate a `lang` block from the conversation context. It arrives from the
 * client, so it is checked, not trusted: `{ code, pinned }` or null.
 */
export function sanitizeLang(raw) {
  if (!raw || typeof raw !== 'object') return null
  const code = normaliseLanguageCode(raw.code)
  if (!code) return null
  return { code, pinned: raw.pinned === true }
}

/**
 * Decide the language for one turn.
 *
 * @param {object} o
 * @param {string} [o.planLanguage]      what the planner read the question as
 * @param {string} [o.requestedLanguage] a language the message asked for, if any
 * @param {{code:string,pinned:boolean}|null} [o.priorLang] the conversation's
 * @param {'planner'|'focus'|'context-chip'|'template'|'fast-path'} [o.via='planner']
 * @returns {{ code: string, lang: {code:string,pinned:boolean}, pinnedByThisTurn: boolean }}
 *   `code` is what this turn is answered in; `lang` is what the conversation
 *   carries forward.
 */
export function decideTurnLanguage(o = {}) {
  const requested = normaliseLanguageCode(o.requestedLanguage)
  const prior = sanitizeLang(o.priorLang)
  const via = o.via || 'planner'
  if (requested) {
    return { code: requested, lang: { code: requested, pinned: true }, pinnedByThisTurn: true }
  }
  if (prior && prior.pinned) {
    return { code: prior.code, lang: prior, pinnedByThisTurn: false }
  }
  if (via === 'focus') {
    const code = prior?.code || 'en'
    return { code, lang: { code, pinned: false }, pinnedByThisTurn: false }
  }
  const typed = via === 'planner' ? normaliseLanguageCode(o.planLanguage) : 'en'
  const code = typed || 'en'
  return { code, lang: { code, pinned: false }, pinnedByThisTurn: false }
}
