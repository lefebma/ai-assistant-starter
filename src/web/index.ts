/**
 * Entry point for the web layer. Route modules register themselves on import,
 * so they live here rather than in http.ts (which they import from). Later
 * tasks add their route module below.
 */
import './http.js'
import './chat-routes.js'
// Before project-goal-routes: its POST /projects/:id would otherwise match /projects/import.
import './project-import-routes.js'
import './project-goal-routes.js'
import './file-routes.js'
import './project-file-routes.js'
import './status-routes.js'
import './dictation-routes.js'
import './voice-chat-routes.js'
import './proactive-routes.js'
import './tips-routes.js'

export { handleWebRequest, webPathFor } from './http.js'
