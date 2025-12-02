const formatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'America/Los_Angeles',
})

export default function LocalTime({ iso }: { iso: string }) {
  const pretty = formatter.format(new Date(iso))
  return <time dateTime={iso}>{pretty} PT</time>
}
