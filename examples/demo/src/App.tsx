// Parcelly is fictional. Everything here is static demo data.
const stats = [
  { label: 'Out for delivery', value: '1,284', delta: '+6.2%', up: true },
  { label: 'Delivered today', value: '3,917', delta: '+11.4%', up: true },
  { label: 'Failed attempts', value: '42', delta: '-3.1%', up: false },
  { label: 'Avg. stop time', value: '2m 48s', delta: '+0.4%', up: false },
];

const routes = [
  { id: 'R-104', driver: 'Ava Lindqvist', zone: 'North Harbour', stops: 38, done: 31, status: 'On time' },
  { id: 'R-117', driver: 'Kofi Mensah', zone: 'Old Town', stops: 44, done: 22, status: 'Delayed' },
  { id: 'R-121', driver: 'Mei Tanaka', zone: 'Riverside', stops: 29, done: 29, status: 'Completed' },
  { id: 'R-128', driver: 'Lucas Ferreira', zone: 'Airport Park', stops: 51, done: 40, status: 'On time' },
  { id: 'R-133', driver: 'Sara Haddad', zone: 'University Hill', stops: 33, done: 12, status: 'Delayed' },
];

const bars = [62, 71, 58, 80, 92, 76, 88];
const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function App() {
  return (
    <div className="shell">
      <Sidebar />
      <main>
        <header className="top">
          <div>
            <h1>Dispatch overview</h1>
            <p className="lead">Live status for today's routes across all depots.</p>
          </div>
          <div className="actions">
            <button className="ghost">Export CSV</button>
            <button className="primary" data-testid="new-route">New route</button>
          </div>
        </header>

        <section className="stats">
          {stats.map(s => <StatCard key={s.label} {...s} />)}
        </section>

        <section className="grid">
          <RoutesTable />
          <ThroughputChart />
        </section>
      </main>
    </div>
  );
}

function Sidebar() {
  const items = ['Overview', 'Routes', 'Drivers', 'Depots', 'Customers', 'Settings'];
  return (
    <aside className="side">
      <div className="logo"><span className="mark">P</span> Parcelly</div>
      <nav>
        {items.map((it, i) => <a key={it} className={i === 0 ? 'on' : ''} href="#">{it}</a>)}
      </nav>
      <div className="me">
        <span className="avatar">JD</span>
        <div><b>Jo Dalton</b><small>Dispatch lead</small></div>
      </div>
    </aside>
  );
}

function StatCard({ label, value, delta, up }: { label: string; value: string; delta: string; up: boolean }) {
  return (
    <div className="card stat">
      <span className="label">{label}</span>
      <strong>{value}</strong>
      <span className={up ? 'delta up' : 'delta down'}>{delta} vs last week</span>
    </div>
  );
}

function RoutesTable() {
  return (
    <div className="card routes">
      <div className="card-head">
        <h2>Active routes</h2>
        <input placeholder="Search routes…" />
      </div>
      <table>
        <thead>
          <tr><th>Route</th><th>Driver</th><th>Zone</th><th>Progress</th><th>Status</th></tr>
        </thead>
        <tbody>
          {routes.map(r => (
            <tr key={r.id}>
              <td className="mono">{r.id}</td>
              <td>{r.driver}</td>
              <td>{r.zone}</td>
              <td>
                <div className="progress"><span style={{ width: `${(r.done / r.stops) * 100}%` }} /></div>
                <small>{r.done}/{r.stops} stops</small>
              </td>
              <td><span className={`badge ${r.status.toLowerCase().replace(' ', '-')}`}>{r.status}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ThroughputChart() {
  return (
    <div className="card chart">
      <div className="card-head"><h2>Deliveries per day</h2><small>Last 7 days</small></div>
      <div className="bars">
        {bars.map((b, i) => (
          <div key={days[i]} className="bar-col">
            <div className="bar" style={{ height: `${b}%` }} />
            <small>{days[i]}</small>
          </div>
        ))}
      </div>
    </div>
  );
}
