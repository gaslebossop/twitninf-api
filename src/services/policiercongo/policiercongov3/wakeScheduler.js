'use strict';

class PersistentWakeScheduler {
  constructor({ memory, agent, config, logger = console }) { this.memory = memory; this.agent = agent; this.config = config; this.logger = logger; this.timer = null; this.running = false; }

  async runDueOnce() {
    if (this.running) return { skipped: true, reason: 'tick_already_running' };
    this.running = true;
    try {
      const wakes = await this.memory.claimDueWakes(this.config.schedulerBatchSize, this.config.schedulerClaimSeconds);
      const results = [];
      for (const wake of wakes) {
        try {
          const result = await this.agent.run(wake.event);
          await this.memory.finishWake(wake.wake_id, 'completed');
          results.push({ wakeId: wake.wake_id, ok: true, runId: result.runId });
        } catch (error) {
          await this.memory.finishWake(wake.wake_id, 'failed', error.message);
          const retryMinutes = Math.min(60, Math.max(5, Number(wake.attempts || 1) * 10));
          await this.memory.scheduleWake({
            threadId: wake.thread_id,
            userId: wake.user_id,
            runAfter: new Date(Date.now() + retryMinutes * 60000).toISOString(),
            event: wake.event,
            reason: `Retry après échec: ${error.message}`
          }).catch(scheduleError => this.logger.error?.(`[pc3.scheduler] Retry non programmé: ${scheduleError.message}`));
          this.logger.error?.(`[pc3.scheduler] ${wake.wake_id}: ${error.message}`);
          results.push({ wakeId: wake.wake_id, ok: false, error: error.message, retryInMinutes: retryMinutes });
        }
      }
      return { skipped: false, claimed: wakes.length, results };
    } finally { this.running = false; }
  }

  start(intervalMs = 30000) {
    if (this.timer) return;
    this.timer = setInterval(() => this.runDueOnce().catch(error => this.logger.error?.(`[pc3.scheduler] ${error.message}`)), Math.max(5000, intervalMs));
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

module.exports = { PersistentWakeScheduler };
