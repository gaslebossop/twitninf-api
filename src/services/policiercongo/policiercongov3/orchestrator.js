'use strict';

const { Op } = require('sequelize');
const models = require('../../../models');
const logger = require('../../../utils/logger');
const { POLICE_ACCOUNT_ID } = require('../config');
const { loadV3Config } = require('./config');
const { AUTONOMOUS_THREAD_ID } = require('./constants');
const { PostgresMemoryStore, InMemoryMemoryStore } = require('./memoryStore');
const { ToolPolicy } = require('./policy');
const { ToolRegistry } = require('./toolRegistry');
const { registerPlatformTools } = require('./platformTools');
const { registerAdminModerationTools } = require('./adminModerationTools');
const { ProviderRouter } = require('./provider');
const { ContextEngine } = require('./contextEngine');
const { AgentLoop } = require('./agentLoop');
const { PersistentWakeScheduler } = require('./wakeScheduler');

class PolicierCongoV3Runtime {
  constructor(options = {}) {
    this.config = loadV3Config(options.config);
    this.logger = options.logger || logger;
    this.models = options.models || models;
    this.memory = options.memory || (this.models?.sequelize
      ? new PostgresMemoryStore({ sequelize: this.models.sequelize, config: this.config, logger: this.logger })
      : new InMemoryMemoryStore({ config: this.config }));
    this.policy = options.policy || new ToolPolicy(this.config);
    // Créé avant le registre d'outils : la vérification croisée des actions
    // destructrices (voir crossModelVerification.js) a besoin du provider
    // router pour interroger l'AUTRE modèle que celui qui a décidé.
    this.provider = options.provider || new ProviderRouter({ config: this.config, logger: this.logger, providers: options.providers });
    this.tools = options.tools || new ToolRegistry({ config: this.config, policy: this.policy, memory: this.memory, logger: this.logger, providerRouter: this.provider });
    if (!options.tools) {
      registerPlatformTools(this.tools, { models: this.models, memory: this.memory, config: this.config, providerRouter: this.provider });
      registerAdminModerationTools(this.tools, { models: this.models, memory: this.memory, config: this.config });
    }
    this.contextEngine = options.contextEngine || new ContextEngine({ config: this.config, memory: this.memory, tools: this.tools });
    this.agent = options.agent || new AgentLoop({ config: this.config, provider: this.provider, memory: this.memory, tools: this.tools, contextEngine: this.contextEngine, logger: this.logger });
    this.scheduler = options.scheduler || new PersistentWakeScheduler({ memory: this.memory, agent: this.agent, config: this.config, logger: this.logger });
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return this;
    await this.memory.ensureSchema();
    if (this.config.schedulerEnabled) {
      const autonomousThread = AUTONOMOUS_THREAD_ID;
      let nextWake = await this.memory.getNextWake(autonomousThread);
      if (!nextWake) {
        const runAfter = new Date(Date.now() + this.config.bootstrapWakeMinutes * 60000).toISOString();
        nextWake = await this.memory.scheduleWake({
          threadId: autonomousThread,
          userId: null,
          runAfter,
          reason: 'Premier passage PolicierCongo V3 après activation ou reprise',
          event: {
            trigger: 'scheduled',
            threadId: autonomousThread,
            text: 'Premier passage agentique V3. Observe TwitNinf avec tes outils, agis si utile, puis programme précisément ton prochain réveil.',
            context: { source: 'v3_bootstrap', continuousAgent: true },
            permissions: { allowRead: true, allowWrite: true, allowSensitive: true, allowDestructive: false, actorRole: 'policiercongo_scheduler' }
          }
        });
        this.logger.info?.(`[pc3] Premier réveil agentique programmé pour ${runAfter}`);
      } else {
        this.logger.info?.(`[pc3] Réveil persistant retrouvé pour ${nextWake.run_after || nextWake.runAfter}`);
      }
      this.scheduler.start(this.config.schedulerIntervalMs);
    }
    this.initialized = true;
    const primaryProvider = this.config.providerOrder[0] || 'codex';
    const primaryModel = primaryProvider === 'claude' ? this.config.claudeModel : this.config.codexModel;
    const primaryEffort = primaryProvider === 'claude' ? this.config.claudeReasoningEffort : this.config.codexReasoningEffort;
    this.logger.info?.(`[pc3] V3 prêt — ${primaryProvider}:${primaryModel}/${primaryEffort}, dryRun=${this.config.dryRun}`);
    return this;
  }

  async getSuspendedAccountContext() {
    const user = await this.models.User.findByPk(POLICE_ACCOUNT_ID);
    if (!user?.is_suspended) return null;
    const now = new Date();
    const suspendedUntil = user.suspended_until ? new Date(user.suspended_until) : null;
    const appealWhere = { user_id: POLICE_ACCOUNT_ID };
    if (user.suspended_at) appealWhere.created_at = { [Op.gte]: user.suspended_at };
    const latestAppeal = this.models.UnbanTicket
      ? await this.models.UnbanTicket.findOne({
        where: appealWhere,
        order: [['created_at', 'DESC']]
      }).catch(() => null)
      : null;
    const remainingMs = suspendedUntil ? Math.max(0, suspendedUntil.getTime() - now.getTime()) : null;
    return {
      account_id: POLICE_ACCOUNT_ID,
      reason: user.suspension_reason || null,
      suspended_at: user.suspended_at ? new Date(user.suspended_at).toISOString() : null,
      suspended_until: suspendedUntil ? suspendedUntil.toISOString() : null,
      is_permanent: !suspendedUntil,
      remaining_ms: remainingMs,
      remaining_hours: remainingMs === null ? null : Math.ceil(remainingMs / 3600000),
      appeal_already_sent: Boolean(latestAppeal),
      latest_appeal_status: latestAppeal?.status || null,
      allowed_tools: ['check_ban_status', 'appeal_ban', 'check_appeal_response']
    };
  }

  async run(input, options) {
    if (!this.config.enabled) throw Object.assign(new Error('PolicierCongo V3 est désactivé (POLICIERCONGO_V3_ENABLED=false)'), { code: 'PC3_DISABLED' });
    await this.initialize();
    const suspension = await this.getSuspendedAccountContext().catch(error => {
      this.logger.warn?.(`[pc3.suspension] Impossible de verifier la suspension: ${error.message}`);
      return null;
    });
    const guardedInput = suspension
      ? {
        ...input,
        context: {
          ...(input?.context || {}),
          policiercongoSuspended: true,
          suspension
        },
        permissions: {
          ...(input?.permissions || {}),
          allowRead: true,
          allowWrite: true,
          allowSensitive: false,
          allowDestructive: false,
          approvalToken: null,
          actorRole: input?.permissions?.actorRole || 'policiercongo_suspended'
        }
      }
      : input;
    const authorizedInput = this.config.allowAllTools && !suspension
      ? {
        ...guardedInput,
        permissions: {
          ...(guardedInput?.permissions || {}),
          allowRead: true,
          allowWrite: true,
          allowSensitive: true,
          allowDestructive: true,
          approvalToken: guardedInput?.permissions?.approvalToken || 'persistent_owner_authorization',
          actorRole: guardedInput?.permissions?.actorRole || 'policiercongo_global'
        }
      }
      : guardedInput;
    return this.agent.run(authorizedInput, options);
  }

  status() {
    // Reflète le provider RÉELLEMENT en tête d'ordre, pas toujours codex :
    // depuis le passage sur Claude (codex à sec), cette route affichait le
    // modèle/effort codex même quand c'est claudeModel/claudeReasoningEffort
    // qui tourne réellement — même logique que le log de initialize().
    const primaryProvider = this.config.providerOrder[0] || 'codex';
    const primaryModel = primaryProvider === 'claude' ? this.config.claudeModel : this.config.codexModel;
    const primaryEffort = primaryProvider === 'claude' ? this.config.claudeReasoningEffort : this.config.codexReasoningEffort;
    return { version: '3.0.0', enabled: this.config.enabled, dry_run: this.config.dryRun,
      provider_order: this.config.providerOrder, model: primaryModel, reasoning_effort: primaryEffort,
      max_iterations: this.config.maxIterations, max_tool_calls: this.config.maxToolCalls,
      allow_all_tools: this.config.allowAllTools,
      cross_verification_enabled: this.config.crossVerificationEnabled,
      tools: this.tools.catalog().map(tool => ({ name: tool.name, risk: tool.risk })),
      scheduler: { enabled: this.config.schedulerEnabled, running: Boolean(this.scheduler.timer), interval_ms: this.config.schedulerIntervalMs },
      initialized: this.initialized };
  }

  async close() { this.scheduler.stop(); this.initialized = false; }
}

let singleton;
function getPolicierCongoV3(options) { if (!singleton) singleton = new PolicierCongoV3Runtime(options); return singleton; }
async function runPolicierCongoV3Turn(input, options) { return getPolicierCongoV3().run(input, options); }
function resetPolicierCongoV3ForTests() { singleton?.close(); singleton = null; }

module.exports = { PolicierCongoV3Runtime, getPolicierCongoV3, runPolicierCongoV3Turn, resetPolicierCongoV3ForTests };
