/**
 * Entry point for the web layer. Route modules register themselves on import,
 * so they live here rather than in http.ts (which they import from). Later
 * tasks add their route module below.
 */
import './http.js'
import './chat-routes.js'
import './project-goal-routes.js'
import './file-routes.js'
import './status-routes.js'

export { handleWebRequest, webPathFor } from './http.js'
