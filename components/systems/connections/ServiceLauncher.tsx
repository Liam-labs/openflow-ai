'use client';

import { SERVICE_CATALOG, UNKNOWN_SERVICE_STATUS, type ServiceId, type ServiceStatus } from './service-catalog';
import styles from './ServiceLauncher.module.css';

export function ServiceLauncher({ statuses, onConnect, onRefresh }: {
  statuses: Partial<Record<ServiceId, ServiceStatus>>;
  onConnect: (id: ServiceId) => void;
  onRefresh: () => void;
}) {
  return <section className={styles.launcher} aria-label="Connect external services">
    <div className={styles.header}><div><h3>Connect your services</h3><p>Choose a service to connect it or check its setup.</p></div><button className={styles.button} onClick={onRefresh}>Refresh status</button></div>
    {[...new Set(SERVICE_CATALOG.map(service => service.category))].map(category => <div className={styles.group} key={category}>
      <h4>{category}</h4>
      <div className={styles.grid}>{SERVICE_CATALOG.filter(service => service.category === category).map(service => {
        const status = statuses[service.id] ?? UNKNOWN_SERVICE_STATUS;
        return <article className={styles.card} key={service.id} aria-label={service.name}>
          <h5>{service.name}</h5><p>{service.description}</p>
          <div className={styles.footer}><span className={styles.status} data-kind={status.kind} role="status">{status.label}</span><button className={styles.button} aria-label={`Connect ${service.name}`} onClick={() => onConnect(service.id)}>Connect</button></div>
        </article>;
      })}</div>
    </div>)}
  </section>;
}
