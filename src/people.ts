// Phase 3: people & time. A person is a Party with the employee role plus
// labor attributes (loaded cost rate, skills, daily hours). Time entries are
// the one place labor cost enters the system — through the same TimeLogged
// event the kernel has had since Phase 0. Payroll stays integrated-out.
import type { PGlite } from '@electric-sql/pglite'
import { logWorkOrderTime } from './documents.js'
import { KernelError } from './events.js'
import { num } from './money.js'

export async function createEmployee(
  db: PGlite,
  tenantId: string,
  input: { name: string; cost_rate: number; skills?: string[]; daily_hours?: number },
) {
  if (input.cost_rate <= 0) throw new KernelError('cost_rate must be positive')
  return db.transaction(async (tx) => {
    const existing = await tx.query<{ id: string; roles: string[] }>(
      'select id, roles from parties where tenant_id = $1 and name = $2',
      [tenantId, input.name],
    )
    let partyId: string
    if (existing.rows[0]) {
      partyId = existing.rows[0].id
      if (!existing.rows[0].roles.includes('employee')) {
        await tx.query(
          "update parties set roles = array_append(roles, 'employee') where tenant_id = $1 and id = $2",
          [tenantId, partyId],
        )
      }
    } else {
      const created = await tx.query<{ id: string }>(
        "insert into parties (tenant_id, name, roles) values ($1, $2, '{employee}') returning id",
        [tenantId, input.name],
      )
      partyId = created.rows[0].id
    }
    await tx.query(
      `insert into employees (tenant_id, party_id, cost_rate, skills, daily_hours, active)
       values ($1, $2, $3, $4, $5, true)
       on conflict (tenant_id, party_id)
       do update set cost_rate = $3, skills = $4, daily_hours = $5, active = true`,
      [tenantId, partyId, input.cost_rate, input.skills ?? [], input.daily_hours ?? 8],
    )
    return {
      name: input.name,
      cost_rate: input.cost_rate,
      skills: input.skills ?? [],
      daily_hours: input.daily_hours ?? 8,
    }
  })
}

export async function listEmployees(db: PGlite, tenantId: string) {
  const r = await db.query<{
    name: string
    cost_rate: string
    skills: string[]
    daily_hours: string
    active: boolean
  }>(
    `select p.name, e.cost_rate, e.skills, e.daily_hours, e.active
     from employees e join parties p on p.id = e.party_id
     where e.tenant_id = $1 and e.active
     order by p.name`,
    [tenantId],
  )
  return r.rows.map((e) => ({
    name: e.name,
    cost_rate: num(e.cost_rate),
    skills: e.skills,
    daily_hours: num(e.daily_hours),
  }))
}

// The canonical way to log time. With an employee name, the roster supplies
// the rate (override allowed); without one, a rate is required and the name is
// free text. Either way it flows through logWorkOrderTime → TimeLogged event.
export async function recordTime(
  db: PGlite,
  tenantId: string,
  input: {
    work_order: string
    hours: number
    employee?: string
    person?: string
    rate?: number
    entry_date?: string
  },
) {
  const wo = await db.query<{ id: string }>(
    'select id from work_orders where tenant_id = $1 and number = $2',
    [tenantId, input.work_order],
  )
  if (!wo.rows[0]) throw new KernelError(`unknown work order "${input.work_order}"`)

  let rate = input.rate
  let partyId: string | undefined
  let personName = input.person
  if (input.employee) {
    const emp = await db.query<{ party_id: string; cost_rate: string }>(
      `select e.party_id, e.cost_rate
       from employees e join parties p on p.id = e.party_id
       where e.tenant_id = $1 and p.name = $2 and e.active`,
      [tenantId, input.employee],
    )
    if (!emp.rows[0]) throw new KernelError(`"${input.employee}" is not on the roster`)
    partyId = emp.rows[0].party_id
    rate = rate ?? num(emp.rows[0].cost_rate)
    personName = input.employee
  }
  if (!rate || rate <= 0)
    throw new KernelError('a rate is required when logging time without a roster employee')

  return logWorkOrderTime(db, tenantId, wo.rows[0].id, {
    hours: input.hours,
    loaded_rate: rate,
    person: personName,
    party_id: partyId,
    entry_date: input.entry_date,
  })
}

export async function listTimeEntries(db: PGlite, tenantId: string, days = 14) {
  const r = await db.query<{
    person_name: string
    on_roster: boolean
    wo_number: string
    sku: string
    hours: string
    rate: string
    labor_cost: string
    entry_date: string
  }>(
    `select te.person_name, (te.party_id is not null) as on_roster,
            w.number as wo_number, i.sku, te.hours, te.rate, te.labor_cost,
            te.entry_date::text as entry_date
     from time_entries te
     join work_orders w on w.id = te.wo_id
     join items i on i.id = w.item_id
     where te.tenant_id = $1 and te.entry_date >= current_date - $2::int
     order by te.entry_date desc, te.created_at desc`,
    [tenantId, days],
  )
  return r.rows.map((t) => ({
    person: t.person_name,
    on_roster: t.on_roster,
    work_order: t.wo_number,
    sku: t.sku,
    hours: num(t.hours),
    rate: num(t.rate),
    labor_cost: num(t.labor_cost),
    entry_date: t.entry_date,
  }))
}
