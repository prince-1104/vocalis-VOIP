"""
Expand scripts/bbmp-data.json into 108 upload rows (18 variants per topic).

For [Hindi Romanized] and [Kannada Romanized], answers are in Latin script
(ITRANS-style romanization) so KB matches users who type/speak in romanized
Hindi/Kannada — not Devanagari/Kannada script in the Answer field.
"""

import json
import re
from pathlib import Path

from indic_transliteration import sanscript
from indic_transliteration.sanscript import transliterate

src = Path("scripts/bbmp-data.json")
out = Path("scripts/bbmp-data-expanded-108-upload.json")

data = json.loads(src.read_text(encoding="utf-8"))


def is_native_devanagari(s: str) -> bool:
    return bool(s) and any("\u0900" <= ch <= "\u097F" for ch in s)


def is_native_kannada(s: str) -> bool:
    return bool(s) and any("\u0C80" <= ch <= "\u0CFF" for ch in s)


def split_variants(queries, native_check):
    native = []
    roman = []
    for q in queries or []:
        if not q:
            continue
        (native if native_check(q) else roman).append(q)
    return native, roman


def prep_hindi_for_roman(s: str) -> str:
    """Normalize Devanagari spellings so ITRANS → readable Latin."""
    s = s.replace("\u0911", "\u0913")  # ऑ → ओ
    s = s.replace("\u0949", "\u094b")  # ॉ → ो
    return s


def romanize_devanagari_runs(text: str) -> str:
    text = prep_hindi_for_roman(text)

    def repl(m: re.Match[str]) -> str:
        return transliterate(m.group(), sanscript.DEVANAGARI, sanscript.ITRANS)

    for _ in range(4):
        next_text = re.sub(r"[\u0900-\u097F]+", repl, text)
        if next_text == text:
            break
        text = next_text
    return text


def romanize_kannada_runs(text: str) -> str:
    def repl(m: re.Match[str]) -> str:
        return transliterate(m.group(), sanscript.KANNADA, sanscript.ITRANS)

    for _ in range(4):
        next_text = re.sub(r"[\u0C80-\u0CFF]+", repl, text)
        if next_text == text:
            break
        text = next_text
    return text


rows = []
for item in data:
    t = item.get("type", "faq")
    title = item.get("title", "Untitled")
    q = item.get("queries", {})
    a = item.get("answers", {})
    v = item.get("videos", {})

    en_q = q.get("english", [])
    hi_q = q.get("hindi", [])
    kn_q = q.get("kannada", [])

    hi_native, hi_roman = split_variants(hi_q, is_native_devanagari)
    kn_native, kn_roman = split_variants(kn_q, is_native_kannada)

    hi_roman_used = hi_roman if hi_roman else [x for x in hi_q if x and not is_native_devanagari(x)]
    kn_roman_used = kn_roman if kn_roman else [x for x in kn_q if x and not is_native_kannada(x)]

    # If the source file only has native-script queries, synthesize roman query
    # lines so retrieval works for voice/text users who type in Latin.
    if not hi_roman_used and (hi_native or hi_q):
        hi_roman_used = [
            romanize_devanagari_runs(x) for x in (hi_native or hi_q) if x
        ]
    if not kn_roman_used and (kn_native or kn_q):
        kn_roman_used = [
            romanize_kannada_runs(x) for x in (kn_native or kn_q) if x
        ]

    ans_en = (a.get("english") or "").strip()
    ans_hi = (a.get("hindi") or "").strip()
    ans_kn = (a.get("kannada") or "").strip()
    ans_hi_roman = romanize_devanagari_runs(ans_hi) if ans_hi else ""
    ans_kn_roman = romanize_kannada_runs(ans_kn) if ans_kn else ""

    v_en = (v.get("english_video") or "").strip()
    v_kn = (v.get("kannada_video") or "").strip()

    packs = [
        (
            "English",
            "en-US",
            ans_en,
            en_q[:10],
            [
                f"Language: English (en-US)",
                f"Answer:\n{ans_en}",
                "",
                "User queries:",
                *[f"- {x}" for x in en_q[:10]],
                "",
                f"Suggested YouTube (English): {v_en}",
                f"Suggested YouTube (Kannada): {v_kn}",
                "Rule: Match user language. At most one video link; no duplicate links.",
            ],
        ),
        (
            "Hindi Native",
            "hi-IN",
            ans_hi,
            (hi_native or hi_q)[:10],
            [
                "भाषा: हिंदी — देवनागरी",
                f"उत्तर:\n{ans_hi}",
                "",
                "ये प्रश्न अक्सर पूछे जाते हैं:",
                *[f"- {x}" for x in (hi_native or hi_q)[:10]],
                "",
                f"सुझाया गया YouTube (English): {v_en}",
                f"सुझाया गया YouTube (Kannada): {v_kn}",
                "नियम: उपयोगकर्ता की भाषा में जवाब दें। एक से ज़्यादा वीडियो लिंक न डालें।",
            ],
        ),
        (
            "Hindi Romanized",
            "hi-IN",
            ans_hi_roman,
            hi_roman_used[:10],
            [
                "Bhasha: Hindi — Roman lipi (ITRANS-style)",
                f"Uttar (Roman Hindi):\n{ans_hi_roman}",
                "",
                "User queries (Roman / Hinglish):",
                *[f"- {x}" for x in hi_roman_used[:10]],
                "",
                f"Suggested YouTube (English): {v_en}",
                f"Suggested YouTube (Kannada): {v_kn}",
                "Rule: Reply in Roman Hindi when user types Roman Hindi. One video link only.",
            ],
        ),
        (
            "Kannada Native",
            "kn-IN",
            ans_kn,
            (kn_native or kn_q)[:10],
            [
                "ಭಾಷೆ: ಕನ್ನಡ — ಮೂಲ ಲಿಪಿ",
                f"ಉತ್ತರ:\n{ans_kn}",
                "",
                "ಸಾಮಾನ್ಯವಾಗಿ ಕೇಳುವ ಪ್ರಶ್ನೆಗಳು:",
                *[f"- {x}" for x in (kn_native or kn_q)[:10]],
                "",
                f"ಸಲಹೆಯ YouTube (English): {v_en}",
                f"ಸಲಹೆಯ YouTube (Kannada): {v_kn}",
                "ನಿಯಮ: ಬಳಕೆದಾರರ ಭಾಷೆಗೆ ಹೊಂದಾಣಿಕೆ. ಒಂದಕ್ಕಿಂತ ಹೆಚ್ಚು ವೀಡಿಯೊ ಲಿಂಕ್ ಬೇಡ.",
            ],
        ),
        (
            "Kannada Romanized",
            "kn-IN",
            ans_kn_roman,
            kn_roman_used[:10],
            [
                "Bhashhe: Kannada — Roman lipi (ITRANS-style Kanglish)",
                f"Uttara (Roman Kannada):\n{ans_kn_roman}",
                "",
                "User queries (Roman Kannada):",
                *[f"- {x}" for x in kn_roman_used[:10]],
                "",
                f"Suggested YouTube (English): {v_en}",
                f"Suggested YouTube (Kannada): {v_kn}",
                "Rule: Reply in Roman Kannada when user types Roman Kannada. One video link only.",
            ],
        ),
    ]

    mixed_queries = ((kn_native[:3] + kn_roman_used[:3]) or kn_q)[:10]
    mixed_lines = [
        "Bhashhe: Kannada — mixed (lipi + Roman)",
        f"Uttara (lipiyalli):\n{ans_kn}",
    ]
    if ans_kn_roman:
        mixed_lines.extend(["", f"Uttara (Roman Kannada):\n{ans_kn_roman}"])
    mixed_lines.extend(
        [
            "",
            "User queries (mixed examples):",
            *[f"- {x}" for x in mixed_queries],
            "",
            f"Suggested YouTube (English): {v_en}",
            f"Suggested YouTube (Kannada): {v_kn}",
            "Rule: Prefer native Kannada script in chat unless user is clearly Roman-only.",
        ]
    )
    packs.append(("Kannada Mixed", "kn-IN", ans_kn, mixed_queries, mixed_lines))

    for label, _code, ans, _qs, lines in packs:
        if not (ans or "").strip() and label not in ("English",):
            continue
        if label == "English" and not ans_en:
            continue
        content = "\n".join(lines).strip()
        rows.append({"type": t, "title": f"{title} [{label}]", "content": content})

out.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
print("source topics:", len(data))
print("generated rows:", len(rows))
print("output:", out)
