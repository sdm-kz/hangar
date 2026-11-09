// Whether Claude's tab shows the terminal or the chat read from it.
//
// Two records of it. This browser's own choice, per session: the phone may want the chat while the desk
// keeps the terminal. And the session's, in its saved UI state, which the server keeps by conversation —
// so it outlasts a stop and a reopen (which mints a new session id that no browser has a choice for yet),
// an app restart's auto-resume, and reaches a device that has never opened the session. A browser with no
// choice of its own goes by the session's.
import { loadSessionUi, saveSessionUi } from "./sessionUi";

const key = (session: string) => `hangar.chatView.${session}`;
// What the last session started from this browser opened in, offered again for the next.
const NEW_SESSION_KEY = "hangar.newSessionChat";

/** This browser's own choice for a session ({@link sessionKey}), or null when it has made none. */
export function localChatView(session: string): boolean | null {
  try {
    const v = localStorage.getItem(key(session));
    return v === "1" ? true : v === "0" ? false : null;
  } catch {
    return null;
  }
}

function writeLocal(session: string, on: boolean) {
  try {
    localStorage.setItem(key(session), on ? "1" : "0");
  } catch {
    /* storage unavailable: the session's own record still holds it */
  }
}

/** Which view a session opens in here: this browser's choice, else the session's, else the terminal. */
export function chatViewOf(session: string): boolean {
  return localChatView(session) ?? loadSessionUi(session).chat ?? false;
}

/** Switch a session's view: for this browser, and as the session's own. */
export function setChatView(session: string, on: boolean) {
  writeLocal(session, on);
  saveSessionUi(session, { chat: on });
}

/**
 * A reopened session is the same work under a new id: this browser's choice goes with it at once, rather
 * than the terminal showing until the session's saved state has been fetched.
 */
export function carryChatView(from: string, to: string) {
  const on = localChatView(from);
  if (on !== null) writeLocal(to, on);
}

/** The view the next new session starts in. */
export function newSessionChat(): boolean {
  try {
    return localStorage.getItem(NEW_SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

export function setNewSessionChat(on: boolean) {
  try {
    localStorage.setItem(NEW_SESSION_KEY, on ? "1" : "0");
  } catch {
    /* storage unavailable: the next dialog starts on the terminal */
  }
}
