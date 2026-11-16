import { beforeEach, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({sql:vi.fn()}));
vi.mock('@/lib/db',()=>({default:m.sql}));
import {previousSettleNav} from '@/lib/paper-db';
beforeEach(()=>vi.clearAllMocks());
it('selects the latest earlier settle before validating NAV, without skipping a zero row',async()=>{
 m.sql.mockResolvedValue([{nav:'0'}]);expect(await previousSettleNav('quant','2026-11-13')).toBeNull();
 const [strings,...values]=m.sql.mock.calls[0];const q=strings.join('?');
 expect(q).toContain("slot = 'settle'");expect(q).toContain('trade_date <');expect(q).toContain('ORDER BY trade_date DESC LIMIT 1');expect(q).not.toMatch(/nav\s*>\s*0/);expect(values).toEqual(['quant','2026-11-13']);
});
it('returns positive numeric NAV and null for missing or invalid latest NAV',async()=>{
 for(const [rows,expected] of [[[{nav:'110'}],110],[[],null],[[{nav:'bad'}],null],[[{nav:'-1'}],null]] as const){m.sql.mockResolvedValue(rows);expect(await previousSettleNav('quant','2026-11-13')).toBe(expected)}
});
