// Re-export all session functions from JSON-based implementation
export {
  getSession,
  upsertSession,
  updateSession,
  sanitizeDisplayName,
  deleteSession,
  clearChromeActive,
  removeScreenshot,
  getAllSessions,
  getSessionPids,
  deleteSessionsByPids,
  cleanupStaleSessions,
  getSessionsDir,
  setSessionsDir,
  ATTACHMENTS_DIR,
  getSessionAttachmentsDir,
  type Session,
  type SessionState,
  type SessionAgent,
  type SessionInput,
  type SessionUpdate,
  type Screenshot,
  readLinks,
  writeLink,
} from "./sessions-json.js";

// Projects the sidebar groups sessions under, remembered on the server.
export {
  getSavedProjects,
  saveProject,
  saveProjects,
  removeProject,
  setProjectsPath,
} from "./projects-json.js";
