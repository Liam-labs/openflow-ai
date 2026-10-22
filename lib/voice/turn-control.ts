// Stand-in for a feature that is not part of this edition. It keeps the app compiling; the feature is off.

export class VoiceTurnConflictError extends Error {
  statusCode = 409;
}

// Called only when a request carries a voice reply context; without the voice feature that is refused with a 409.
export function voiceResponseMessageId(_input: any): string {
  throw new VoiceTurnConflictError('Voice replies are not available in this edition');
}

export async function validateVoiceReplyContext(_input: any): Promise<any> {
  throw new VoiceTurnConflictError('Voice replies are not available in this edition');
}
