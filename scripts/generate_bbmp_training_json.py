import json
from pathlib import Path

videos = json.loads(Path('scripts/bbmp-videos.json').read_text(encoding='utf-8'))
by_title = {v['title'].lower(): v for v in videos}

def v(title):
    x = by_title.get(title.lower(), {})
    return {"english": x.get('link_en',''), "kannada": x.get('link_kn','')}

items = [
  {
    "type":"product_info",
    "title":"What is e-Khata",
    "answer":"e-Khata is the digital property record issued by BBMP for properties in Bengaluru. It digitizes ownership and tax-linked details so records are searchable, verifiable, and easier to update.",
    "sampleQuestions":["what is e khata","ekhata meaning","e khata yenidu","ekhata kya hai","tell me about e-khata"],
    "video": v("What is e-Khata?")
  },
  {
    "type":"product_info",
    "title":"How to apply for e-Khata online",
    "answer":"Visit https://ekhata.bbmp.gov.in, login with OTP, search property (SAS/PID/owner), review details, upload documents if required, pay official fee, and submit. Track status under My Applications.",
    "sampleQuestions":["how to apply e khata","online apply e khata","ekhata apply madodu hege","e khata kaise apply kare"],
    "video": v("How to Apply for e-Khata")
  },
  {
    "type":"faq",
    "title":"Difference between Draft and Final e-Khata",
    "answer":"Draft e-Khata is preliminary data from tax/property records and may have incomplete fields. Final e-Khata is verified and legally usable for approvals/transactions after validation and fee payment.",
    "sampleQuestions":["draft vs final e khata","draft final difference","draft final antar","final e khata difference"],
    "video": v("Difference between Draft and Final e-Khata")
  },
  {
    "type":"faq",
    "title":"Difference between e-Khata and New Khata",
    "answer":"Regular e-Khata usually refers to migration/verification of existing records in BBMP systems. New Khata is for fresh khata creation (for eligible new/unregistered/changed ownership cases). Required documents and scrutiny can differ.",
    "sampleQuestions":["difference e khata and new khata","new khata vs e khata","e khata matthu new khata difference","khata madhu new khata beda"],
    "video": v("Difference between Regular e-Khata and New Khata")
  },
  {
    "type":"faq",
    "title":"Why e-Khata is needed",
    "answer":"e-Khata improves transparency, reduces fraud, supports faster verification, and is increasingly required for civic approvals and property transactions.",
    "sampleQuestions":["why need e khata","e khata yake beku","benefits of e khata","e khata kyu zaroori"],
    "video": v("Why we need e-Khata")
  },
  {
    "type":"faq",
    "title":"Official e-Khata fees and payment",
    "answer":"Pay only on official BBMP channels. Charges depend on service type (draft/final/download/application center). Never pay brokers without official receipt.",
    "sampleQuestions":["e khata fees","payment for e khata","how much cost e khata","ekhata charge estu"],
    "video": v("How to pay to get e-Khata")
  },
  {
    "type":"faq",
    "title":"How to apply online step-by-step",
    "answer":"Open BBMP e-Khata portal, authenticate by OTP, choose service, enter property details, upload required docs, pay if applicable, submit, then monitor status online.",
    "sampleQuestions":["step by step online apply","online process e khata","portal apply guide","ekhata online steps"],
    "video": v("How to apply online for e-Khata")
  },
  {
    "type":"faq",
    "title":"Draft e-Khata missing",
    "answer":"If draft is missing, re-check SAS/PID/owner spelling, try legacy owner details, and raise grievance from portal with supporting docs for manual verification.",
    "sampleQuestions":["draft e khata missing","property not found draft","draft bartha illa","draft nahi mil raha"],
    "video": v("What if your Draft e-Khata is missing")
  },
  {
    "type":"faq",
    "title":"Non-transactable to transactable Final e-Khata",
    "answer":"Submit correction/upgrade request with ownership proofs and required validation. BBMP verification is needed before status changes from non-transactable to transactable.",
    "sampleQuestions":["non transactable to transactable","final khata transactable","non transactable e khata","transactable madodu hege"],
    "video": v("Make Final e-Khata Transactable (from Non-Transactable)")
  },
  {
    "type":"faq",
    "title":"How to raise grievance",
    "answer":"Use grievance/help section on portal with application/property reference and clear issue description. Track ticket ID for follow-up.",
    "sampleQuestions":["raise grievance","how to complain e khata","complaint ekhatage","grievance where"],
    "video": v("How and where to raise a grievance")
  },
  {
    "type":"product_info",
    "title":"What is New Khata",
    "answer":"New Khata is for fresh khata creation in eligible scenarios where regular e-Khata conversion is not enough. It requires case-specific document validation.",
    "sampleQuestions":["what is new khata","new khata yenidu","new khata meaning","new khata kya hai"],
    "video": v("What is New Khata")
  },
  {
    "type":"faq",
    "title":"Property under court order",
    "answer":"If court order/dispute exists, submission requires legal documents and processing follows legal compliance. Final outcome depends on court directions and BBMP scrutiny.",
    "sampleQuestions":["court order property","property dispute khata","court case ide property","court order e khata"],
    "video": v("What if there is a court order on the property")
  },
  {
    "type":"faq",
    "title":"Errors in Final e-Khata",
    "answer":"Raise correction with evidence (sale deed, ID, tax docs, supporting proof). Mention exact wrong fields (name/area/PID/address/share) and submit through official workflow.",
    "sampleQuestions":["error in final e khata","wrong name in khata","mistake correction e khata","final khata tappu"],
    "video": v("What if there are errors in Final e-Khata")
  },
  {
    "type":"faq",
    "title":"NRI procedure for e-Khata",
    "answer":"NRI applicants can apply using valid identity/ownership documents and required authorization where applicable. Ensure document consistency and portal-compliant uploads.",
    "sampleQuestions":["nri e khata","nri procedure","outside india owner e khata","nri apply khata"],
    "video": v("Procedure for NRI to obtain e-Khata")
  },
  {
    "type":"faq",
    "title":"VP/MSB New Khata procedure",
    "answer":"For VP/MSB category properties, follow the dedicated new khata process and upload category-specific supporting records for verification.",
    "sampleQuestions":["vp msb khata","vp and msb procedure","vp new khata apply","msb khata details"],
    "video": v("Procedure for VP and MSB to obtain New Khata")
  },
  {
    "type":"faq",
    "title":"New Khata for multiple flats or units",
    "answer":"For multiple units/flats, ensure each unit/owner mapping is clear and submit unit-wise details/documents as required by portal workflow.",
    "sampleQuestions":["multiple flats new khata","apartment units khata","many units khata","multiple unit application"],
    "video": v("Apply New Khata for multiple flats or units")
  },
  {
    "type":"faq",
    "title":"Multiple names clubbed in application",
    "answer":"Names may be clubbed when records indicate joint/linked ownership. Verify owner shares and supporting docs before requesting split/correction.",
    "sampleQuestions":["multiple names clubbed","joint owner names combined","17 18 combined khata","names merged in application"],
    "video": v("Multiple names clubbed in the eKhata application (Sections 17+18)")
  },
  {
    "type":"objection_handling",
    "title":"How to file objection to Final e-Khata",
    "answer":"Use official objection/correction flow, provide property reference and documentary proof, and monitor acknowledgement/ticket status.",
    "sampleQuestions":["file objection final khata","objection process","raise objection e khata","final e khata objection"],
    "video": v("How to File an Objection to Final e-Khata")
  },
  {
    "type":"faq",
    "title":"How to apply for New Khata",
    "answer":"Choose New Khata service in portal, provide property basis and ownership chain, upload mandatory docs, pay official charges, and submit for scrutiny.",
    "sampleQuestions":["apply new khata","new khata application","new khata apply madodu hege","new khata kaise apply"],
    "video": v("How to apply for New Khata")
  },
  {
    "type":"faq",
    "title":"SARFAESI order related e-Khata",
    "answer":"Where SARFAESI/legal enforcement applies, submission and approval depend on legal records and competent authority instructions.",
    "sampleQuestions":["sarfaesi khata","bank seized property khata","sarfaesi order e khata","legal enforcement property"],
    "video": v("e-Khata under SARFAESI Order")
  },
  {
    "type":"faq",
    "title":"What are LPEs",
    "answer":"LPEs are Local Property Enquiry support points/process touchpoints for property-related assistance as notified by authorities.",
    "sampleQuestions":["what is lpe","what are lpes","lpe center details","lpe meaning"],
    "video": v("What are LPEs (Local Property Enquiries)")
  },
  {
    "type":"faq",
    "title":"What happens after New Khata application",
    "answer":"After submission, application goes through scrutiny/verification. You can track status online; if query is raised, upload additional documents promptly.",
    "sampleQuestions":["after applying new khata","what next after submission","new khata status after apply","application submit aadmele enu"],
    "video": v("What happens after New Khata application is submitted online")
  },
  {
    "type":"faq",
    "title":"Official portal URL and safety",
    "answer":"Use only official BBMP e-Khata portal: https://ekhata.bbmp.gov.in. Avoid look-alike sites and never share OTP outside official flow.",
    "sampleQuestions":["official website","portal link","real bbmp site","ekhata portal url"],
    "video": v("How to apply online for e-Khata")
  },
  {
    "type":"faq",
    "title":"Documents generally needed",
    "answer":"Typical docs: identity proof, ownership proof (sale deed/registered docs), property tax references (SAS/PID), and case-specific supporting files as required.",
    "sampleQuestions":["documents required","what documents needed","paper list e khata","yava documents beku"],
    "video": v("How to get Final e-Khata")
  },
  {
    "type":"objection_handling",
    "title":"Handle mixed-language noisy user query",
    "answer":"Interpret intent first, then answer in detected user language. If still ambiguous, ask one short clarification between two likely intents.",
    "sampleQuestions":["new khata dalli difference heli","e khata new khata beda","khata madhu new khata difference"],
    "video": v("Difference between Regular e-Khata and New Khata")
  },
  {
    "type":"objection_handling",
    "title":"Avoid overconfident legal claims",
    "answer":"If exact clause/timeline is uncertain, state that it is case-dependent and advise user to check latest status through official portal or grievance desk.",
    "sampleQuestions":["exact days for approval","which legal clause","guarantee timeline"],
    "video": v("How and where to raise a grievance")
  },
  {
    "type":"faq",
    "title":"Video suggestion policy",
    "answer":"When intent matches a known topic, suggest only one best-fit YouTube tutorial link and avoid repeating the same link multiple times in one answer.",
    "sampleQuestions":["show me video","tutorial link","youtube recommendation","guide video"],
    "video": v("What is e-Khata?")
  },
  {
    "type":"faq",
    "title":"Disambiguate similar difference questions",
    "answer":"When user says only 'difference', first infer from context. If context is weak, ask: Do you mean Draft vs Final e-Khata or e-Khata vs New Khata?",
    "sampleQuestions":["difference khata","khata beda","which difference"],
    "video": v("Difference between Draft and Final e-Khata")
  }
]

master = {
  "dataset": "bbmp_ekhata_training_master",
  "version": "2026-05-07",
  "languageCoverage": ["en", "kn", "hi", "transliterated"],
  "items": items
}

upload_ready = []
for it in items:
    lines = [
      f"Answer:\n{it['answer']}",
      "",
      "User phrasings:",
      *[f"- {q}" for q in it['sampleQuestions']],
      "",
      f"Suggested YouTube (English): {it['video'].get('english','')}",
      f"Suggested YouTube (Kannada): {it['video'].get('kannada','')}",
      "",
      "Rule: Suggest at most one video per reply and do not repeat same video twice in one answer."
    ]
    upload_ready.append({
      "type": it["type"],
      "title": it["title"],
      "content": "\n".join(lines).strip()
    })

Path('scripts/bbmp-training-master.json').write_text(json.dumps(master, ensure_ascii=False, indent=2), encoding='utf-8')
Path('scripts/bbmp-training-upload-ready.json').write_text(json.dumps(upload_ready, ensure_ascii=False, indent=2), encoding='utf-8')
print('wrote', len(items), 'items')
