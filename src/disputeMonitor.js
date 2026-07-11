const {
  DISPUTE_THREADS_CHANNEL_ID,
  VERIFIERS_ALERTS_CHANNEL_ID,
  VOTING_DISCUSSION_CHANNEL_ID,
  FOUR_DAYS_IN_MS,
} = require("./config");

// threadId -> Set of userIds that have already posted in that thread
const disputeParticipationCache = new Map();

async function runInitialDisputeScan(client) {
  console.log("[Dispute Monitor] Starting thread scan on startup...");
  try {
    const disputeChannel = await client.channels.fetch(DISPUTE_THREADS_CHANNEL_ID);
    const alertsChannel = await client.channels.fetch(VERIFIERS_ALERTS_CHANNEL_ID);

    if (!disputeChannel || !alertsChannel) return;

    // Fetch recent alerts to avoid duplicate spam on Railway restarts
    const recentAlerts = await alertsChannel.messages.fetch({ limit: 100 });
    const alreadyAlertedUrls = new Set();
    recentAlerts.forEach((m) => {
      if (m.author.id === client.user.id) {
        const urlMatch = m.content.match(/https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+/);
        if (urlMatch) alreadyAlertedUrls.add(urlMatch[0]);
      }
    });

    const activeThreads = await disputeChannel.threads.fetchActive();
    const now = Date.now();

    for (const [threadId, thread] of activeThreads.threads) {
      if (now - thread.createdTimestamp <= FOUR_DAYS_IN_MS) {

        if (!disputeParticipationCache.has(threadId)) {
          disputeParticipationCache.set(threadId, new Set());
        }
        const participants = disputeParticipationCache.get(threadId);

        const messages = await thread.messages.fetch({ limit: 100 });

        const sortedMessages = Array.from(messages.values()).sort((a, b) => a.createdTimestamp - b.createdTimestamp);

        for (const msg of sortedMessages) {
          if (msg.author.bot) continue;

          let ruleBroken = null;
          if (msg.type === 19 || msg.reference) {
            ruleBroken = "No replies (User replied to another message)";
          } else if (participants.has(msg.author.id)) {
            ruleBroken = "One message per thread (Multiple messages detected)";
          }

          participants.add(msg.author.id);

          if (ruleBroken && !alreadyAlertedUrls.has(msg.url)) {
            await alertsChannel.send({
              content: `🚨 **Violation detected during Initial Scan**\n**User:** ${msg.author.tag} (<@${msg.author.id}>)\n**Thread:** <#${threadId}>\n**Rule Broken:** \`${ruleBroken}\`\n**Message Link:** ${msg.url}`
            });

            try {
              const discussionChannel = await client.channels.fetch(VOTING_DISCUSSION_CHANNEL_ID);
              if (discussionChannel) {
                await discussionChannel.send({
                  content: `Hey <@${msg.author.id}>, you just violated a rule in the <#${threadId}> dispute thread.\n**Rule Broken:** \`${ruleBroken}\`\n*Please remember that dispute threads have strict participation rules.*`
                });
              }
            } catch (err) {
              console.error("[Dispute Monitor] Could not send public warning:", err);
            }

            alreadyAlertedUrls.add(msg.url); // Prevent double alerts in the same loop
          }
        }
      }
    }
    console.log("[Dispute Monitor] Initial scan completed.");
  } catch (error) {
    console.error("[Dispute Monitor] Error during initial scan:", error);
  }
}

async function cleanupDisputeCache(client) {
  console.log("[Dispute Monitor] Running routine cache cleanup...");
  for (const threadId of disputeParticipationCache.keys()) {
    try {
      const thread = await client.channels.fetch(threadId).catch(() => null);

      if (!thread || (Date.now() - thread.createdTimestamp > FOUR_DAYS_IN_MS)) {
        disputeParticipationCache.delete(threadId);
        console.log(`[Dispute Monitor] Cleared old thread ${threadId} from RAM.`);
      }
    } catch (error) {
      disputeParticipationCache.delete(threadId);
    }
  }
}

async function handleMessage(client, message) {
  if (message.author.bot) return;
  if (!message.channel.isThread() || message.channel.parentId !== DISPUTE_THREADS_CHANNEL_ID) return;

  const threadAge = Date.now() - message.channel.createdTimestamp;

  // Only analyze threads up to 4 days old
  if (threadAge > FOUR_DAYS_IN_MS) return;

  const threadId = message.channel.id;
  const userId = message.author.id;
  let ruleBroken = null;

  // Initialize cache for this thread if it doesn't exist
  if (!disputeParticipationCache.has(threadId)) {
    disputeParticipationCache.set(threadId, new Set());

    // Rebuild memory in case of a recent Railway restart
    try {
      const pastMessages = await message.channel.messages.fetch({ limit: 100 });
      pastMessages.forEach((m) => {
        if (!m.author.bot && m.id !== message.id) {
          disputeParticipationCache.get(threadId).add(m.author.id);
        }
      });
    } catch (e) {
      console.error("[Dispute Monitor] Error initializing cache:", e);
    }
  }

  const participants = disputeParticipationCache.get(threadId);

  if (message.type === 19 || message.reference) {
    ruleBroken = "No replies (User is replying to another message)";
  } else if (participants.has(userId)) {
    ruleBroken = "One message / Reposting (User already participated in this thread)";
  }

  // Register user in cache, regardless of violations
  participants.add(userId);

  if (ruleBroken) {
    try {
      const alertsChannel = await client.channels.fetch(VERIFIERS_ALERTS_CHANNEL_ID);
      if (alertsChannel) {
        await alertsChannel.send({
          content: `🚨 **Violation detected in Dispute Threads**\n**User:** ${message.author.tag} (<@${userId}>)\n**Thread:** <#${threadId}>\n**Rule Broken:** \`${ruleBroken}\`\n**Message Link:** ${message.url}`
        });
      }

      const discussionChannel = await client.channels.fetch(VOTING_DISCUSSION_CHANNEL_ID);
      if (discussionChannel) {
        await discussionChannel.send({
          content: `Hey <@${userId}>, you just violated a rule in the <#${threadId}> dispute thread.\n**Rule Broken:** \`${ruleBroken}\`\n*Please remember that dispute threads have strict participation rules.*`
        });
      }
    } catch (error) {
      console.error("[Dispute Monitor] Error sending alert:", error);
    }
  }
}

module.exports = { runInitialDisputeScan, cleanupDisputeCache, handleMessage };
