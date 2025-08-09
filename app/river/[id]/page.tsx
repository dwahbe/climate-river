import { query } from '@/lib/db';
import Link from 'next/link';
export const dynamic = 'force-dynamic';
type Item = { title:string; url:string; source:string; published_at:string; };
export default async function ClusterPage({ params }: { params:{ id:string } }) {
  const id = Number(params.id);
  const { rows } = await query<Item>(`
    select a.title, a.canonical_url as url, s.name as source, a.published_at
    from article_clusters ac
    join articles a on a.id = ac.article_id
    join sources s on s.id = a.source_id
    where ac.cluster_id=$1
    order by a.published_at desc
  `, [id]);
  const lead = rows[0];
  return (
    <main style={{ padding: 24, maxWidth: 960, margin: '0 auto' }}>
      <p><Link href="/river">← Back</Link></p>
      <h1 style={{ marginBottom: 8 }}>{lead ? lead.title : 'Cluster'}</h1>
      <ul style={{ paddingLeft: 18 }}>
        {rows.map((it, i) => (
          <li key={i} style={{ marginBottom: 8 }}>
            <a href={it.url} target="_blank" rel="noreferrer">{it.title}</a>
            <span style={{ color:'#666', marginLeft: 6, fontSize: 12 }}> · {it.source} · {new Date(it.published_at).toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
