export const DEFAULT_CHAT_SESSION_TASK_LIMIT = 4;

// One setting for this installation, not a plan/session permission. The main
// process validates IPC independently of the number input in Settings.
export function validateChatSessionTaskLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10) {
    throw Object.assign(new Error('Укажите целое число микрозадач от 1 до 10.'),
      { code: 'CHAT_SESSION_TASK_LIMIT_INVALID' });
  }
  return value;
}

// Old settings.json files predate rotation. A present but invalid value is an
// error, not an invitation to silently overwrite a user's chosen limit.
export function restoreChatSessionTaskLimit(settings) {
  return settings && Object.hasOwn(settings, 'chatSessionTaskLimit')
    ? validateChatSessionTaskLimit(settings.chatSessionTaskLimit)
    : DEFAULT_CHAT_SESSION_TASK_LIMIT;
}
