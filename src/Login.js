import React from 'react'
import { Stack, TextField, PrimaryButton, MessageBar, MessageBarType, Text } from '@fluentui/react'

export function Login({ onLogin }) {
    const [username, setUsername] = React.useState('')
    const [password, setPassword] = React.useState('')
    const [error, setError] = React.useState(null)
    const [busy, setBusy] = React.useState(false)

    function submit(ev) {
        ev.preventDefault()
        setBusy(true)
        setError(null)
        fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        }).then(res => {
            if (res.ok) {
                onLogin()
            } else {
                return res.text().then(t => { throw new Error(t) })
            }
        }).catch(e => setError(e.message)).finally(() => setBusy(false))
    }

    return (
        <form onSubmit={submit}>
            <Stack tokens={{ childrenGap: 12 }} styles={{ root: { maxWidth: 320, margin: '80px auto', padding: 16 } }}>
                <Text variant="xLarge">Home Surveillance</Text>
                <TextField label="User" autoComplete="username" value={username} onChange={(ev, v) => setUsername(v)} autoFocus />
                <TextField label="Password" type="password" canRevealPassword autoComplete="current-password" value={password} onChange={(ev, v) => setPassword(v)} />
                <PrimaryButton type="submit" text="Sign in" disabled={busy || !username || !password} />
                {error && <MessageBar messageBarType={MessageBarType.error} isMultiline={false}>{error}</MessageBar>}
            </Stack>
        </form>
    )
}
