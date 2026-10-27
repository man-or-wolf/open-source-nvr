import React from 'react'
import { Panel, Stack, TextField, Dropdown, PrimaryButton, DefaultButton, MessageBar, MessageBarType, Separator, Text, IconButton } from '@fluentui/react'

async function api(method, url, body) {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body && { body: JSON.stringify(body) }) })
    if (!res.ok) throw new Error(await res.text())
}

export function PanelUsers({ open, onDismiss, me }) {
    const [users, setUsers] = React.useState([])
    const [error, setError] = React.useState(null)
    const [form, setForm] = React.useState({ username: '', password: '', role: 'viewer' })
    const [pw, setPw] = React.useState({ current: '', password: '' })
    const isAdmin = me && me.role === 'admin'

    const load = React.useCallback(() => {
        if (!isAdmin) return
        fetch('/api/users').then(r => r.json()).then(setUsers).catch(e => setError(e.message))
    }, [isAdmin])
    React.useEffect(() => { if (open) load() }, [open, load])

    const run = (fn) => fn().then(() => { setError(null); load() }).catch(e => setError(e.message))

    return (
        <Panel headerText="Users" isOpen={open} onDismiss={onDismiss} closeButtonAriaLabel="Close">
            <Stack tokens={{ childrenGap: 8 }}>
                <Separator><b>Change my password</b></Separator>
                <TextField label="Current password" type="password" value={pw.current} onChange={(ev, v) => setPw({ ...pw, current: v })} />
                <TextField label="New password (min 8)" type="password" value={pw.password} onChange={(ev, v) => setPw({ ...pw, password: v })} />
                <DefaultButton text="Change password" disabled={pw.password.length < 8 || !pw.current}
                    onClick={() => run(() => api('POST', '/api/password', pw).then(() => setPw({ current: '', password: '' })))} />

                {isAdmin && <>
                    <Separator><b>Users</b></Separator>
                    {users.map(u => (
                        <Stack horizontal verticalAlign="center" key={u.name} horizontalAlign="space-between">
                            <Text>{u.name} ({u.role})</Text>
                            <IconButton iconProps={{ iconName: 'Delete' }} title="Delete" disabled={u.name === me.name}
                                onClick={() => window.confirm(`Delete user ${u.name}?`) && run(() => api('DELETE', `/api/users/${encodeURIComponent(u.name)}`))} />
                        </Stack>
                    ))}
                    <Separator><b>Add / reset user</b></Separator>
                    <TextField label="User" value={form.username} onChange={(ev, v) => setForm({ ...form, username: v })} />
                    <TextField label="Password (min 8)" type="password" value={form.password} onChange={(ev, v) => setForm({ ...form, password: v })} />
                    <Dropdown label="Role" selectedKey={form.role} options={[{ key: 'viewer', text: 'Viewer (watch only)' }, { key: 'admin', text: 'Admin' }]}
                        onChange={(ev, o) => setForm({ ...form, role: o.key })} />
                    <PrimaryButton text="Save user" disabled={!form.username || form.password.length < 8}
                        onClick={() => run(() => api('POST', '/api/users', form).then(() => setForm({ username: '', password: '', role: 'viewer' })))} />
                </>}
                {error && <MessageBar messageBarType={MessageBarType.error} isMultiline={true}>{error}</MessageBar>}
            </Stack>
        </Panel>
    )
}
