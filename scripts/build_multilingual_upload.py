import json
from pathlib import Path

src = Path('scripts/bbmp-training-master.json')
out = Path('scripts/bbmp-training-upload-ready-multilingual.json')

data = json.loads(src.read_text(encoding='utf-8'))
items = data['items']

HI_HINTS = ('kya', 'kaise', 'kyu', 'nahi', 'hai', 'antar', 'zaroori')
KN_HINTS = ('hege', 'yake', 'beku', 'yenidu', 'dalli', 'beda', 'tappu', 'aamele', 'aadmele', 'enu')

def pick_qs(lst, hints):
    picked = [q for q in lst if any(h in q.lower() for h in hints)]
    if not picked:
        picked = lst[:2]
    return picked[:2]

mult = []
for it in items:
    en = it.get('answer','').strip()
    qs = it.get('sampleQuestions', [])
    hi_qs = pick_qs(qs, HI_HINTS)
    kn_qs = pick_qs(qs, KN_HINTS)
    v_en = it.get('video',{}).get('english','')
    v_kn = it.get('video',{}).get('kannada','') or v_en

    # concise language-specific response templates + original answer for factual fidelity
    hi_answer = f"ज़रूर। {en}"
    kn_answer = f"ಖಂಡಿತ. {en}"

    content = "\n".join([
        f"English Answer:\n{en}",
        "",
        "Hindi I/O:",
        *[f"Q: {q}" for q in hi_qs],
        f"A: {hi_answer}",
        "",
        "Kannada I/O:",
        *[f"Q: {q}" for q in kn_qs],
        f"A: {kn_answer}",
        "",
        "Suggested YouTube (English): " + v_en,
        "Suggested YouTube (Kannada): " + v_kn,
        "",
        "Rule: Suggest only one best-fit video. Do not repeat same link in same reply."
    ]).strip()

    mult.append({
        'type': it['type'],
        'title': it['title'],
        'content': content,
    })

out.write_text(json.dumps(mult, ensure_ascii=False, indent=2), encoding='utf-8')
print('wrote', len(mult), 'entries to', out)
