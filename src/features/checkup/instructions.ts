import { replyTextStrategyFor } from '../../domain/capability-matrix'
import { buildSystemPrompt } from '../../domain/prompt-builder'
import { checkupPersonaText, type CheckupPersona } from '../../domain/checkup-persona'
/** Same pure assembler as buildInstructions; deliberately no state-reading thunks. */
export function interviewInstructions(providerId:string,model:string,persona:CheckupPersona={name:'CC'},executors:string[]=[]):string {
  return buildSystemPrompt({providerId,model,peerProviderId:providerId,companionEnabled:false,delegateAvailable:false,persona:checkupPersonaText(persona),personaCultivate:false,replyText:replyTextStrategyFor(providerId),conversationActions:{executors}})
}
