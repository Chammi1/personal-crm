import { db } from '../index.js';

export interface Pet {
  id: number;
  owner_id: number;
  name: string;
  species: string | null;
  breed: string | null;
  avatar: string | null;
  birthday: string | null;
  note: string | null;
  created_at: string;
}

export function create(ownerId: number, p: {
  name: string; species?: string | null; breed?: string | null;
  birthday?: string | null; note?: string | null;
}): number {
  const info = db.prepare(`
    INSERT INTO pet (owner_id, name, species, breed, birthday, note)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(ownerId, p.name, p.species ?? null, p.breed ?? null, p.birthday ?? null, p.note ?? null);
  return Number(info.lastInsertRowid);
}

export function ofOwner(ownerId: number): Pet[] {
  return db.prepare('SELECT * FROM pet WHERE owner_id = ? ORDER BY id').all(ownerId) as Pet[];
}

export function byId(id: number): Pet | undefined {
  return db.prepare('SELECT * FROM pet WHERE id = ?').get(id) as Pet | undefined;
}

export function update(id: number, patch: Partial<Pick<Pet, 'name' | 'species' | 'breed' | 'birthday' | 'note'>>): void {
  const fields = Object.keys(patch) as (keyof typeof patch)[];
  if (!fields.length) return;
  const sql = `UPDATE pet SET ${fields.map((f) => `${f} = @${f}`).join(', ')} WHERE id = @id`;
  const params: Record<string, unknown> = { id };
  for (const f of fields) params[f] = patch[f] || null;
  db.prepare(sql).run(params);
}

export function setAvatar(id: number, file: string): void {
  db.prepare('UPDATE pet SET avatar = ? WHERE id = ?').run(file, id);
}

export function remove(id: number): void {
  db.prepare('DELETE FROM pet WHERE id = ?').run(id);
}
