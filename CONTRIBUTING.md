# Contributing

Thanks for wanting to help. This is how to make a change that gets merged quickly.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- Security problems: see SECURITY.md. Do not post them as issues.

## Set up

Follow the README quick start, then:

    npm run typecheck
    npm run lint
    npm test

## Making a change

1. Branch from `main`. Keep one change per pull request.
2. Add or update a test for the behaviour you changed. Say in the description how you checked the real user path.
3. Do not add keys, personal paths, machine names or customer data anywhere, including tests and examples. Use neutral placeholders.
4. Run the three commands above. A pull request that fails them is not reviewed.

## How changes are merged

For now, maintainers apply accepted pull requests to their own tree and publish from there, so your change arrives in the next release with your name on the commit. Review comments will say if this affects timing.

## Conduct

Everyone taking part follows the CODE_OF_CONDUCT.md.
