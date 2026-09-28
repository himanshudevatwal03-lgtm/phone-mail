import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const domain = (process.env.EMAIL_DOMAIN || 'phonemail.com').toLowerCase();

export function normalizePhone(value) {
  const input = String(value || '').trim();
  const digits = input.replace(/\D/g, '');
  if (!digits || digits.length < 7 || digits.length > 15) throw new Error('Enter a valid phone number with country code.');
  const e164 = input.startsWith('+') ? `+${digits}` : input.startsWith('00') ? `+${digits.slice(2)}` : `+${digits}`;
  if (!/^\+[1-9]\d{6,14}$/.test(e164)) throw new Error('Enter the number in international format, for example +14155550123.');
  return e164;
}

export function emailFromPhone(phone) {
  return `${phone.replace(/\D/g, '')}@${domain}`;
}

export async function initializeDatabase() {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      phone_e164 text NOT NULL UNIQUE,
      email_address text NOT NULL UNIQUE,
      display_name text NOT NULL DEFAULT '',
      avatar_url text,
      language text NOT NULL DEFAULT 'English',
      mobile_app_installed boolean NOT NULL DEFAULT false,
      onboarding_source text NOT NULL DEFAULT 'web',
      password_hash text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS aliases (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      alias_email text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      type text NOT NULL CHECK (type IN ('direct', 'group', 'external')),
      title text NOT NULL DEFAULT '',
      direct_key text UNIQUE,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS conversation_members (
      conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (conversation_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id uuid REFERENCES users(id) ON DELETE SET NULL,
      sender_name text NOT NULL DEFAULT '',
      sender_email text NOT NULL DEFAULT '',
      to_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
      cc_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
      subject text NOT NULL DEFAULT '',
      body_text text NOT NULL DEFAULT '',
      body_html text,
      attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
      reply_to_id uuid REFERENCES messages(id) ON DELETE SET NULL,
      status text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'draft')),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_reply_per_message ON messages(reply_to_id) WHERE reply_to_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS messages_conversation_created ON messages(conversation_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS message_states (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      read_at timestamptz,
      is_favorite boolean NOT NULL DEFAULT false,
      is_spam boolean NOT NULL DEFAULT false,
      is_trash boolean NOT NULL DEFAULT false,
      PRIMARY KEY (user_id, message_id)
    );
    CREATE TABLE IF NOT EXISTS local_otps (
      phone_e164 text PRIMARY KEY,
      code_hash text NOT NULL,
      expires_at timestamptz NOT NULL,
      attempts integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS conversation_members_user ON conversation_members(user_id);
  `);
}

export function query(text, params) {
  return pool.query(text, params);
}

export async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getUserById(id) {
  const { rows } = await query('SELECT * FROM users WHERE id=$1', [id]);
  return rows[0] || null;
}

export async function getUserByPhone(phone) {
  const { rows } = await query('SELECT * FROM users WHERE phone_e164=$1', [phone]);
  return rows[0] || null;
}

export async function getUserByAddress(address) {
  const value = String(address || '').trim();
  if (!value) return null;
  const { rows } = await query(
    `SELECT u.* FROM users u
     LEFT JOIN aliases a ON a.user_id=u.id
     WHERE lower(u.email_address)=lower($1) OR lower(a.alias_email)=lower($1) OR u.phone_e164=$2
     LIMIT 1`,
    [value, value.startsWith('+') ? value : `+${value.replace(/\D/g, '')}`]
  );
  return rows[0] || null;
}

export async function getOrCreateUser(phone, { source = 'web', displayName = '' } = {}) {
  const clean = normalizePhone(phone);
  const { rows } = await query(
    `INSERT INTO users (phone_e164, email_address, display_name, onboarding_source)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (phone_e164) DO UPDATE SET phone_e164=EXCLUDED.phone_e164
     RETURNING *`,
    [clean, emailFromPhone(clean), displayName || `+${clean.slice(1)}`, source]
  );
  return rows[0];
}

async function addMembers(client, conversationId, userIds) {
  for (const userId of [...new Set(userIds)]) {
    await client.query('INSERT INTO conversation_members (conversation_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [conversationId, userId]);
  }
}

async function getOrCreateDirectTx(client, sender, recipient) {
  const directKey = [sender.id, recipient.id].sort().join(':');
  const { rows } = await client.query(
    `INSERT INTO conversations (type,direct_key,created_by)
     VALUES ('direct',$1,$2) ON CONFLICT (direct_key) DO UPDATE SET direct_key=EXCLUDED.direct_key
     RETURNING *`, [directKey, sender.id]
  );
  const conversation = rows[0];
  await addMembers(client, conversation.id, [sender.id, recipient.id]);
  return conversation;
}

async function getOrCreateExternalTx(client, recipient, fromAddress, senderName) {
  const directKey = `external:${recipient.id}:${fromAddress.toLowerCase()}`;
  const { rows } = await client.query(
    `INSERT INTO conversations (type,direct_key,title,created_by)
     VALUES ('external',$1,$2,$3) ON CONFLICT (direct_key) DO UPDATE SET direct_key=EXCLUDED.direct_key
     RETURNING *`, [directKey, senderName || fromAddress, recipient.id]
  );
  const conversation = rows[0];
  await addMembers(client, conversation.id, [recipient.id]);
  return conversation;
}

export async function openConversation(userId, phone) {
  const recipient = await getUserByPhone(normalizePhone(phone));
  if (!recipient) throw new Error('No PhoneMail user is registered with that number yet.');
  if (recipient.id === userId) throw new Error('You cannot start a conversation with yourself.');
  return withTransaction(async client => {
    const sender = await getUserById(userId);
    return getOrCreateDirectTx(client, sender, recipient);
  });
}

export async function saveDraft(userId, fields, existingId) {
  const values = [
    JSON.stringify(fields.to || []), JSON.stringify(fields.cc || []), fields.subject || '',
    fields.bodyText || '', fields.bodyHtml || null, JSON.stringify(fields.attachments || [])
  ];
  if (existingId) {
    const { rows } = await query(
      `UPDATE messages SET to_addresses=$1,cc_addresses=$2,subject=$3,body_text=$4,body_html=$5,attachments=$6
       WHERE id=$7 AND sender_id=$8 AND status='draft' RETURNING *`, [...values, existingId, userId]
    );
    if (!rows[0]) throw new Error('Draft not found.');
    return rows[0];
  }
  const user = await getUserById(userId);
  const { rows } = await query(
    `INSERT INTO messages (sender_id,sender_name,sender_email,to_addresses,cc_addresses,subject,body_text,body_html,attachments,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft') RETURNING *`,
    [userId, user.display_name, user.email_address, ...values]
  );
  return rows[0];
}

export async function createMessage(userId, fields) {
  const user = await getUserById(userId);
  const to = [...new Set((fields.to || []).map(String).map(v => v.trim()).filter(Boolean))];
  if (fields.isDraft) return { draft: await saveDraft(userId, fields, fields.draftId), conversation: null, recipients: [] };
  if (!to.length) throw new Error('Add at least one recipient.');
  const recipients = [];
  for (const address of to) {
    const recipient = await getUserByAddress(address);
    if (!recipient) throw new Error(`No PhoneMail account found for ${address}. Ask them to verify their phone number first.`);
    if (recipient.id !== userId && !recipients.some(item => item.id === recipient.id)) recipients.push(recipient);
  }
  if (!recipients.length) throw new Error('Choose someone other than yourself.');

  return withTransaction(async client => {
    let conversation;
    if (fields.conversationId) {
      const result = await client.query(
        `SELECT c.* FROM conversations c JOIN conversation_members m ON m.conversation_id=c.id
         WHERE c.id=$1 AND m.user_id=$2`, [fields.conversationId, userId]
      );
      if (!result.rows[0]) throw new Error('Conversation not found.');
      conversation = result.rows[0];
    } else if (recipients.length === 1) {
      conversation = await getOrCreateDirectTx(client, user, recipients[0]);
    } else {
      const groupTitle = String(fields.groupName || recipients.map(item => item.display_name).join(', ')).slice(0, 80);
      const result = await client.query('INSERT INTO conversations (type,title,created_by) VALUES (\'group\',$1,$2) RETURNING *', [groupTitle, userId]);
      conversation = result.rows[0];
      await addMembers(client, conversation.id, [userId, ...recipients.map(item => item.id)]);
    }

    const memberResult = await client.query('SELECT user_id FROM conversation_members WHERE conversation_id=$1', [conversation.id]);
    const memberIds = memberResult.rows.map(row => row.user_id);
    if (fields.conversationId) {
      const expectedRecipients = memberIds.filter(memberId => memberId !== userId).sort();
      const chosenRecipients = recipients.map(item => item.id).sort();
      if (expectedRecipients.length !== chosenRecipients.length || expectedRecipients.some((id, index) => id !== chosenRecipients[index])) {
        throw new Error('Recipients are locked for this conversation. Start a new message to add people.');
      }
    }
    let replyTo = null;
    if (fields.replyToId) {
      const original = await client.query('SELECT id,conversation_id,subject FROM messages WHERE id=$1 AND conversation_id=$2', [fields.replyToId, conversation.id]);
      if (!original.rows[0]) throw new Error('The message you are replying to is no longer available.');
      replyTo = original.rows[0];
    }
    const senderName = user.display_name || user.phone_e164;
    const insert = await client.query(
      `INSERT INTO messages (conversation_id,sender_id,sender_name,sender_email,to_addresses,cc_addresses,subject,body_text,body_html,attachments,reply_to_id,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'sent') RETURNING *`,
      [conversation.id, userId, senderName, user.email_address,
        JSON.stringify(to), JSON.stringify(fields.cc || []), fields.subject || (replyTo ? `Re: ${replyTo.subject}` : ''),
        fields.bodyText || '', fields.bodyHtml || null, JSON.stringify(fields.attachments || []), replyTo?.id || null]
    );
    const message = insert.rows[0];
    for (const memberId of memberIds) {
      await client.query(
        `INSERT INTO message_states (user_id,message_id,read_at) VALUES ($1,$2,$3)
         ON CONFLICT (user_id,message_id) DO NOTHING`,
        [memberId, message.id, memberId === userId ? new Date() : null]
      );
    }
    await client.query('UPDATE conversations SET updated_at=now() WHERE id=$1', [conversation.id]);
    return { message, conversation, recipients };
  });
}

export async function sendDraft(userId, draftId, fields = null) {
  if (fields) await saveDraft(userId, fields, draftId);
  const { rows } = await query('SELECT * FROM messages WHERE id=$1 AND sender_id=$2 AND status=\'draft\'', [draftId, userId]);
  const draft = rows[0];
  if (!draft) throw new Error('Draft not found.');
  const result = await createMessage(userId, {
    to: draft.to_addresses, cc: draft.cc_addresses, subject: draft.subject, bodyText: draft.body_text,
    bodyHtml: draft.body_html, attachments: draft.attachments
  });
  await query('DELETE FROM messages WHERE id=$1', [draftId]);
  return result;
}

export async function listConversations(userId, { folder = 'all', filter = 'all', search = '' } = {}) {
  if (folder === 'drafts') {
    const drafts = await listDrafts(userId);
    return drafts.map(item => ({ id: item.id, type: 'draft', title: item.subject || 'New message', preview: item.body_text, updated_at: item.created_at, draft: item }));
  }
  const { rows } = await query(
    `SELECT c.id,c.type,c.title,c.updated_at,
       (SELECT json_build_object('id',m.id,'sender_id',m.sender_id,'sender_name',m.sender_name,'sender_email',m.sender_email,'subject',m.subject,'body_text',m.body_text,'attachments',m.attachments,'created_at',m.created_at)
        FROM messages m WHERE m.conversation_id=c.id AND m.status='sent' ORDER BY m.created_at DESC LIMIT 1) AS last_message,
       (SELECT count(*)::int FROM messages m JOIN message_states s ON s.message_id=m.id AND s.user_id=$1
        WHERE m.conversation_id=c.id AND m.status='sent' AND m.sender_id IS DISTINCT FROM $1 AND s.read_at IS NULL AND NOT s.is_spam AND NOT s.is_trash) AS unread_count,
       (SELECT coalesce(json_agg(json_build_object('id',u.id,'phoneNumber',u.phone_e164,'emailAddress',u.email_address,'displayName',u.display_name,'avatarUrl',u.avatar_url)), '[]'::json)
        FROM conversation_members cm JOIN users u ON u.id=cm.user_id WHERE cm.conversation_id=c.id AND u.id<>$1) AS participants,
       EXISTS(SELECT 1 FROM messages m JOIN message_states s ON s.message_id=m.id AND s.user_id=$1 WHERE m.conversation_id=c.id AND s.is_favorite) AS has_favorite,
       EXISTS(SELECT 1 FROM messages m JOIN message_states s ON s.message_id=m.id AND s.user_id=$1 WHERE m.conversation_id=c.id AND s.is_spam) AS has_spam,
       EXISTS(SELECT 1 FROM messages m JOIN message_states s ON s.message_id=m.id AND s.user_id=$1 WHERE m.conversation_id=c.id AND s.is_trash) AS has_trash,
       EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND jsonb_array_length(m.attachments)>0) AS has_attachments
     FROM conversations c JOIN conversation_members mine ON mine.conversation_id=c.id AND mine.user_id=$1
     WHERE ($2='' OR c.title ILIKE '%'||$2||'%' OR EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND (m.subject ILIKE '%'||$2||'%' OR m.body_text ILIKE '%'||$2||'%')))
       AND (($3='all')
         OR ($3='unread' AND EXISTS(SELECT 1 FROM messages m JOIN message_states s ON s.message_id=m.id AND s.user_id=$1 WHERE m.conversation_id=c.id AND m.sender_id IS DISTINCT FROM $1 AND s.read_at IS NULL AND NOT s.is_spam AND NOT s.is_trash))
         OR ($3='attachments' AND EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND jsonb_array_length(m.attachments)>0))
         OR ($3='favorites' AND EXISTS(SELECT 1 FROM messages m JOIN message_states s ON s.message_id=m.id AND s.user_id=$1 WHERE m.conversation_id=c.id AND s.is_favorite)))
       AND ($4='all' OR ($4='spam' AND EXISTS(SELECT 1 FROM messages m JOIN message_states s ON s.message_id=m.id AND s.user_id=$1 WHERE m.conversation_id=c.id AND s.is_spam))
         OR ($4='trash' AND EXISTS(SELECT 1 FROM messages m JOIN message_states s ON s.message_id=m.id AND s.user_id=$1 WHERE m.conversation_id=c.id AND s.is_trash)))
       AND EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.status='sent')
     ORDER BY c.updated_at DESC LIMIT 100`, [userId, search, filter, folder]
  );
  return rows;
}

export async function listDrafts(userId) {
  const { rows } = await query('SELECT * FROM messages WHERE sender_id=$1 AND status=\'draft\' ORDER BY created_at DESC', [userId]);
  return rows;
}

export async function getConversation(userId, conversationId) {
  const { rows } = await query(
    `SELECT c.* FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id
     WHERE c.id=$1 AND cm.user_id=$2`, [conversationId, userId]
  );
  if (!rows[0]) return null;
  const conversation = rows[0];
  const members = await query(
    `SELECT u.id,u.phone_e164 AS "phoneNumber",u.email_address AS "emailAddress",u.display_name AS "displayName",u.avatar_url AS "avatarUrl"
     FROM conversation_members cm JOIN users u ON u.id=cm.user_id WHERE cm.conversation_id=$1 AND u.id<>$2`, [conversationId, userId]
  );
  const messages = await query(
    `SELECT m.*,s.read_at,s.is_favorite,s.is_spam,s.is_trash,
       EXISTS(SELECT 1 FROM messages child WHERE child.reply_to_id=m.id) AS has_reply
     FROM messages m LEFT JOIN message_states s ON s.message_id=m.id AND s.user_id=$2
     WHERE m.conversation_id=$1 AND m.status='sent' ORDER BY m.created_at ASC`, [conversationId, userId]
  );
  await query(
    `UPDATE message_states s SET read_at=now() FROM messages m
     WHERE s.message_id=m.id AND s.user_id=$1 AND m.conversation_id=$2 AND m.sender_id IS DISTINCT FROM $1 AND s.read_at IS NULL`, [userId, conversationId]
  );
  return { ...conversation, participants: members.rows, messages: messages.rows };
}

export async function changeMessageState(userId, messageId, change) {
  const message = await query(
    `SELECT m.id FROM messages m JOIN conversation_members cm ON cm.conversation_id=m.conversation_id
     WHERE m.id=$1 AND cm.user_id=$2 AND m.status='sent'`, [messageId, userId]
  );
  if (!message.rows[0]) throw new Error('Message not found.');
  await query('INSERT INTO message_states (user_id,message_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, messageId]);
  const allowed = new Set(['is_favorite', 'is_spam', 'is_trash']);
  if (change.read === true) await query('UPDATE message_states SET read_at=now() WHERE user_id=$1 AND message_id=$2', [userId, messageId]);
  if (change.read === false) await query('UPDATE message_states SET read_at=NULL WHERE user_id=$1 AND message_id=$2', [userId, messageId]);
  for (const key of allowed) if (typeof change[key] === 'boolean') await query(`UPDATE message_states SET ${key}=$3 WHERE user_id=$1 AND message_id=$2`, [userId, messageId, change[key]]);
  return true;
}

export async function searchUsers(userId, term) {
  const value = String(term || '').trim();
  if (value.length < 2) return [];
  const digits = value.replace(/\D/g, '');
  const pattern = `%${value}%`;
  const { rows } = await query(
    `SELECT id,phone_e164 AS "phoneNumber",email_address AS "emailAddress",display_name AS "displayName",avatar_url AS "avatarUrl"
     FROM users WHERE id<>$1 AND (phone_e164 ILIKE $2 OR email_address ILIKE $2 OR display_name ILIKE $3)
     ORDER BY CASE WHEN phone_e164=$4 THEN 0 ELSE 1 END,display_name LIMIT 12`,
    [userId, `%${digits || value}%`, pattern, value.startsWith('+') ? value : `+${digits}`]
  );
  return rows;
}

export async function createAlias(userId, localPart) {
  const label = String(localPart || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(label)) throw new Error('Alias must be 3–32 characters and use letters, numbers, dots, underscores, or hyphens.');
  const aliasEmail = `${label}@${domain}`;
  const { rows } = await query('INSERT INTO aliases (user_id,alias_email) VALUES ($1,$2) RETURNING id,alias_email AS "aliasEmail",created_at', [userId, aliasEmail]);
  return rows[0];
}

export async function getAliases(userId) {
  const { rows } = await query('SELECT id,alias_email AS "aliasEmail",created_at FROM aliases WHERE user_id=$1 ORDER BY created_at', [userId]);
  return rows;
}

export async function deleteAlias(userId, aliasId) {
  const result = await query('DELETE FROM aliases WHERE id=$1 AND user_id=$2', [aliasId, userId]);
  return result.rowCount > 0;
}

export async function updateProfile(userId, fields) {
  const { rows } = await query(
    `UPDATE users SET display_name=COALESCE($2,display_name),avatar_url=COALESCE($3,avatar_url),language=COALESCE($4,language)
     WHERE id=$1 RETURNING *`, [userId, fields.displayName ?? null, fields.avatarUrl ?? null, fields.language ?? null]
  );
  return rows[0];
}

export async function markMobileAppInstalled(userId) {
  await query('UPDATE users SET mobile_app_installed=true WHERE id=$1', [userId]);
}

export async function ingestInboundEmail({ fromEmail, fromName, toAddresses, subject, bodyText, bodyHtml, attachments = [] }) {
  const sender = String(fromEmail || '').trim();
  const recipients = [];
  for (const address of toAddresses) {
    const user = await getUserByAddress(address);
    if (user && !recipients.some(item => item.id === user.id)) recipients.push(user);
  }
  if (!recipients.length) throw new Error('No PhoneMail account matches the recipient address.');
  const { message, conversation } = await withTransaction(async client => {
    let conv;
    if (recipients.length === 1) conv = await getOrCreateExternalTx(client, recipients[0], sender, fromName);
    else {
      const result = await client.query('INSERT INTO conversations (type,title,created_by) VALUES (\'group\',$1,$2) RETURNING *', [fromName || sender, recipients[0].id]);
      conv = result.rows[0];
      await addMembers(client, conv.id, recipients.map(item => item.id));
    }
    const inserted = await client.query(
      `INSERT INTO messages (conversation_id,sender_name,sender_email,to_addresses,subject,body_text,body_html,attachments)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [conv.id, fromName || sender, sender, JSON.stringify(toAddresses), subject || '(No subject)', bodyText || '', bodyHtml || null, JSON.stringify(attachments)]
    );
    const msg = inserted.rows[0];
    for (const recipient of recipients) await client.query('INSERT INTO message_states (user_id,message_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [recipient.id, msg.id]);
    await client.query('UPDATE conversations SET updated_at=now() WHERE id=$1', [conv.id]);
    return { message: msg, conversation: conv };
  });
  return { message, conversation, recipients };
}

export async function getPasswordHash(userId) {
  const { rows } = await query('SELECT password_hash FROM users WHERE id=$1', [userId]);
  return rows[0]?.password_hash || null;
}

export async function setPasswordForPhone(phone, passwordHash) {
  const user = await getOrCreateUser(phone, { source: 'web' });
  await query('UPDATE users SET password_hash=$2 WHERE id=$1', [user.id, passwordHash]);
  return getUserById(user.id);
}

export async function authenticatePassword(phone, passwordHash) {
  const user = await getUserByPhone(normalizePhone(phone));
  if (!user?.password_hash) return null;
  return user.password_hash === passwordHash ? user : null;
}

export async function createGroupTitle(userId, conversationId, title) {
  const { rows } = await query('UPDATE conversations c SET title=$3 WHERE c.id=$1 AND EXISTS(SELECT 1 FROM conversation_members m WHERE m.conversation_id=c.id AND m.user_id=$2) RETURNING c.*', [conversationId, userId, String(title).slice(0, 80)]);
  return rows[0] || null;
}

export function newId() {
  return randomUUID();
}

export { pool };
