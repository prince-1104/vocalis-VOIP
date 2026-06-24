/** Detect when the caller is done and the AI has delivered a closing line. */

const CALLER_DONE_PATTERNS: RegExp[] = [
  /\b(goodbye|bye bye|bye)\b/i,
  /\b(that'?s (all|it)|nothing else|no more questions?|no further questions?)\b/i,
  /\bno\b.*\bnothing\b/i,
  /\bnothing\b.*\b(thank|thanks)\b/i,
  /^(no[,.\s!]*)+(thank you|thanks)\s*[.!]?\s*$/i,
  /\bnot interested\b/i,
  /\b(i'?m|i am) (good|done|fine)\b/i,
  /^(ok(ay)?|sure)?[,.\s]*(thank you|thanks)\s*[.!]?\s*$/i,
  // Hindi / Hinglish
  /\b(alvida|अलविदा)\b/i,
  /\b(dhanyavaad|dhanyawad|धन्यवाद)\b/i,
  /\b(shukriya|शुक्रिया)\b/i,
  /\b(bas|बस)\b.*\b(itna|इतना|ho gaya|हो गया)\b/i,
  /\b(nahi|nhi|नहीं)\b.*\b(kuch nahi|कुछ नहीं|aur nahi|और नहीं)\b/i,
  /\b(theek hai|ठीक है)\b.*\b(dhanyavaad|धन्यवाद|shukriya|शुक्रिया|thank)\b/i,
  /\b(ok|okay|theek)\b.*\b(bye|बाय)\b/i,
  /\b(ho gaya|हो गया|bas ho gaya|बस हो गया)\b/i,
];

const AI_CLOSING_PATTERNS: RegExp[] = [
  /\bhave a (great|wonderful|nice|good) day\b/i,
  /\bgoodbye\b/i,
  /\bthank you for (calling|your time|reaching out)\b/i,
  /\btake care\b/i,
  /\bwe appreciate (your|you)\b/i,
  /\bfeel free to reach out\b/i,
  // Hindi / Hinglish
  /\b(अलविदा|alvida)\b/i,
  /\b(शुभ दिन|shubh din)\b/i,
  /\b(कॉल करने के लिए धन्यवाद|call karne ke liye dhanyavaad)\b/i,
  /\b(ध्यान रखें|dhyan rakhein)\b/i,
  /\b(फोन करने के लिए|phone karne ke liye)\b.*\b(धन्यवाद|शुक्रिया|dhanyavaad|shukriya)\b/i,
  /\b(हम आपसे संपर्क|hum aapse sampark|हम.*संपर्क करेंगे)\b/i,
];

const AI_CONTINUES_PATTERNS: RegExp[] = [
  /\b(anything else|can i help|is there anything|would you like|do you have any other|shall i|let me know if)\b/i,
  // Hindi
  /\b(और कुछ|aur kuch|कुछ और|kuch aur|मदद कर सकती|madad kar sakti)\b/i,
];

export function callerWantsToEnd(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return CALLER_DONE_PATTERNS.some((p) => p.test(t));
}

export function isAIClosingResponse(text: string, endingPitch?: string | null): boolean {
  const t = text.trim();
  if (!t) return false;

  if (AI_CONTINUES_PATTERNS.some((p) => p.test(t))) return false;

  if (endingPitch && endingPitch.length > 12) {
    const snippet = endingPitch.toLowerCase().slice(0, Math.min(24, endingPitch.length));
    if (t.toLowerCase().includes(snippet)) return true;
  }

  return AI_CLOSING_PATTERNS.some((p) => p.test(t));
}

export function shouldAutoHangupAfterTurn(
  userMessage: string,
  aiResponse: string,
  endingPitch?: string | null,
): boolean {
  if (!callerWantsToEnd(userMessage)) return false;
  return isAIClosingResponse(aiResponse, endingPitch);
}
