import './config/env.js'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import path from 'path'
import { fileURLToPath } from 'url'

import dramas from './routes/dramas.js'
import episodes from './routes/episodes.js'
import storyboards from './routes/storyboards.js'
import scenes from './routes/scenes.js'
import characters from './routes/characters.js'
import tasks from './routes/tasks.js'
import upload from './routes/upload.js'
import aiConfigs, { aiProviders } from './routes/aiConfigs.js'
import stylePresets from './routes/stylePresets.js'
import prompts from './routes/prompts.js'
import agent from './routes/agent.js'
import merge from './routes/merge.js'
import skills from './routes/skills.js'
import props from './routes/props.js'
import auth from './routes/auth.js'
import { authRequired } from './middleware/auth.js'
import { localStorageRoot, storageDriver, validateEnvironment } from './config/env.js'
import { requestLogger, errorHandler } from './middleware/logger.js'
import { recoverProcessingGenerationTasks } from './services/generation.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '../..')

const app = new Hono()
validateEnvironment()

// Middleware
app.use('*', cors({
  origin: ['http://localhost:3013', 'http://localhost:5679'],
  credentials: true,
}))
app.use('*', requestLogger)
app.use('*', errorHandler)

// Health check
app.get('/api/v1/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }))

// API routes
const api = new Hono()
// 认证接口在全局鉴权之前挂载；其余 API 默认必须携带合法 JWT。
api.route('/auth', auth)
api.use('*', authRequired)
api.route('/dramas', dramas)
api.route('/episodes', episodes)
api.route('/storyboards', storyboards)
api.route('/scenes', scenes)
api.route('/characters', characters)
api.route('/tasks', tasks)
api.route('/upload', upload)
api.route('/ai-configs', aiConfigs)
api.route('/ai-providers', aiProviders)
api.route('/style-presets', stylePresets)
api.route('/prompts', prompts)
api.route('/agent', agent)
api.route('/merge', merge)
api.route('/skills', skills)
api.route('/props', props)

app.route('/api/v1', api)

// Serve static files (storage)
// 生成的图片/视频按 uuid 命名、内容不变，标记为 immutable 让浏览器长缓存
app.use('/static/*', async (c, next) => {
  await next()
  if (c.res.ok) c.header('Cache-Control', 'public, max-age=31536000, immutable')
})
if (storageDriver === 'local') {
  app.use('/static/*', serveStatic({
    root: localStorageRoot,
    rewriteRequestPath: requestPath => requestPath.replace(/^\/static/, ''),
  }))
}

// Serve frontend (production build). Disable when Nuxt runs separately in development.
if (process.env.SERVE_FRONTEND !== 'false') {
  const distPath = path.join(projectRoot, 'frontend', 'dist')
  app.use('*', serveStatic({ root: distPath }))
  app.get('*', serveStatic({ root: distPath, path: 'index.html' }))
}

const port = Number(process.env.PORT || 5679)
await recoverProcessingGenerationTasks()
console.log(`🚀 Huobao Drama TS server on http://localhost:${port}`)
serve({ fetch: app.fetch, port })
