# Deploying this fork

This fork (`origin`, iddhi-sulakshana/teamclaude) runs on one server. Upstream
is KarpelesLab/teamclaude (`upstream`). The server tracks `origin/master`, so
whatever reaches `master` here is what the next deploy runs.

## The server

- **Host:** `root@<server>` — the DigitalOcean droplet, the `default` profile
  of the `ssh-mcp-digitalocean` SSH MCP server. The address is kept out of
  this file because the repository is public.
- **Checkout:** `/opt/teamclaude`, on `master`, remote `origin` (this fork).
- **Binary:** the global `teamclaude` under nvm's Node (v24.21.0) links to the
  checkout (`/opt/teamclaude/src/index.js`), so pulling the checkout updates
  the binary. Nothing is built or copied.
- **Service:** systemd unit `teamclaude`, running `teamclaude server --headless`.
- **Dependencies:** the package has no runtime dependencies (only
  `devDependencies`), so a deploy needs no install step. If that ever changes,
  add `npm install --omit=dev` to the deploy command.

## Adding a feature

```sh
cd /Volumes/storage/Codes/teamclaude
git checkout -b feat/<name>
# make changes, then run the checks CI runs:
node --test && bun run lint && bun run typecheck && bun run typecheck:strict
git push -u origin feat/<name>
git checkout master && git merge --ff-only feat/<name> && git push origin master
```

Then deploy (below). Keep fork-only changes, such as this file, off feature
branches: they are also the branches offered upstream as pull requests.

## Deploy

```sh
ssh root@<server> 'cd /opt/teamclaude && git pull --ff-only && systemctl restart teamclaude'
```

`--ff-only` stops the deploy instead of creating a merge commit on the
server if its checkout has diverged from `origin/master`.

## Check it

```sh
ssh root@<server> 'systemctl is-active teamclaude && cd /opt/teamclaude && git log --oneline -1'
ssh root@<server> 'journalctl -u teamclaude -n 50 --no-pager'
```

The commit printed should be `master`'s tip, and the log should show the
server starting without errors. Then open the dashboard
(`/teamclaude/dashboard`) and look at what changed.

## Roll back

Prefer a revert, so the server and `master` never disagree:

```sh
git revert <sha> && git push origin master
```

then deploy as above. In an emergency, pin the server to the last good
commit first and revert afterwards:

```sh
ssh root@<server> 'cd /opt/teamclaude && git reset --hard <good-sha> && systemctl restart teamclaude'
```

The next `git pull --ff-only` moves it forward again once `master` is fixed.

## Pulling in upstream

```sh
git fetch upstream && git merge upstream/master
# run the checks, then:
git push origin master
```

and deploy the same way.
