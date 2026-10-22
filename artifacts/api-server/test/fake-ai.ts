export const aiCalls: string[] = [];
export const aiBehavior: { sttError: unknown; chatReply: string | null } = {
  sttError: null,
  chatReply: null,
};
export const chatPrompts: any[][] = [];
export const chatRequests: any[] = [];
export const openai = {
  audio: {
    transcriptions: {
      create: async () => {
        aiCalls.push("stt");
        if (aiBehavior.sttError) throw aiBehavior.sttError;
        return { text: "I need a human agent" };
      },
    },
    speech: {
      create: async () => {
        throw new Error("Unexpected unmocked TTS dispatch");
      },
    },
  },
  chat: {
    completions: {
      create: async (request: any) => {
        if (aiBehavior.chatReply == null)
          throw new Error("Unexpected unmocked LLM dispatch");
        chatPrompts.push(request.messages);
        chatRequests.push(request);
        return {
          choices: [{ message: { content: aiBehavior.chatReply } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        };
      },
    },
  },
};
