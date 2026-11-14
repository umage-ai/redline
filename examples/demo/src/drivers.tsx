// Parcelly is fictional. The Drivers page: a second route, so notes can be pinned per page.
import { Sidebar } from './App.tsx';

const drivers = [
  { name: 'Ava Lindqvist', depot: 'North Harbour', van: 'EV-12', rating: 4.9, shift: 'Morning', status: 'On route' },
  { name: 'Kofi Mensah', depot: 'Old Town', van: 'EV-07', rating: 4.6, shift: 'Morning', status: 'On break' },
  { name: 'Mei Tanaka', depot: 'Riverside', van: 'D-31', rating: 4.8, shift: 'Early', status: 'Finished' },
  { name: 'Lucas Ferreira', depot: 'Airport Park', van: 'EV-19', rating: 4.7, shift: 'Day', status: 'On route' },
  { name: 'Sara Haddad', depot: 'University Hill', van: 'D-44', rating: 4.5, shift: 'Day', status: 'On route' },
  { name: 'Noah Becker', depot: 'North Harbour', van: '-', rating: 4.4, shift: 'Late', status: 'Off today' },
];

export function DriversPage() {
  const onRoute = drivers.filter(d => d.status === 'On route').length;
  return (
    <div className="shell">
      <Sidebar active="Drivers" />
      <main>
        <header className="top">
          <div>
            <h1>Drivers</h1>
            <p className="lead">{onRoute} of {drivers.length} drivers are on a route right now.</p>
          </div>
          <div className="actions">
            <button className="primary" data-testid="invite-driver"><span aria-hidden="true">+</span> Invite driver</button>
          </div>
        </header>

        <section className="card routes">
          <div className="card-head"><h2>Team</h2><small>Sorted by name</small></div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Driver</th><th>Depot</th><th>Van</th><th>Shift</th><th>Rating</th><th>Status</th></tr>
              </thead>
              <tbody>
                {drivers.map(d => (
                  <tr key={d.name}>
                    <td>{d.name}</td>
                    <td>{d.depot}</td>
                    <td className="mono">{d.van}</td>
                    <td>{d.shift}</td>
                    <td>★ {d.rating.toFixed(1)}</td>
                    <td><span className={`badge ${d.status === 'On route' ? 'on-time' : d.status === 'Finished' ? 'completed' : 'delayed'}`}>{d.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
