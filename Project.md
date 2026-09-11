## thoughts

### Project Description
A ClI that will be used to create centralized brain for a AI assisted project development consisting of multiple services. This CLI will attach a brain(basically a git repo) to all the repos which are a building an project to make all them work together without disrupting each other work but constantly aligned with each other all the time.

### Purpose
Currently everyone is using AI coding tools to write codes, although all AI assistant coding tools are great in writing code, they are able to understand all the requirements easily, write great code with context of the current repo on which user is working. This is great if you are working on a standalone project which is in single repo. But that usually not the case in terms of how big projects and orgs run. They usually have a large project, that got broken down to smaller functionalities(microservices) and each of functionalities will have one or more repos for them. So when developers start working on this kind of project they will always loose the overall context on what is going on all of microservice. Reason why we need this cli. is to make our plan/spec/features more aligned, better with context of whole project and build everything faster and more reliable and in sync.

#### Components
1. CLI - CLI will server below functionalities.
    - init
        - Setup Guide(for multiple AI coding tools) starts with claude-code, codex, pi.
        - Provide some default skills that user can add their project(Optional for user)
        - Add certain claude like commands to user repo, which user can use to improve their development workflows.
        - Update Claude.md or similar kind of files used by different AI assisted tools, to use thoughts CLI/templates everytime when planning, creating specs, researching, commiting, making decisions in the repo.
        - Add agents.md which user can use if needed.
        - Symlink the Org/Project level thoughts(brain) repo to the current project as an symlink.
        - Allow user to use their own org level templates if they don't want the default ones provided.
        - setup integration will start with 3 Github, Azure DevOps, Jira.
    - sync
        - Sync local directory with anything new in thoughts repo or push the any changes done in the current repo.
    - status 
        - Check what's in the flight
    - search
        - search thoughts in other repos
    - new
        - generate something new using default templates
2. Templates
    - plan
    - spec
    - PR
    - commit
    - research
3. Standard
    - skills/
    - agents/
    - commands/
    - Claude.md(or similar)
4. Index & Metadata using GOOGLE OKF https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md