# Chrome Web Store package (manifest + JS/HTML/CSS + icons only).
# Version is not auto-bumped on release — run bump-patch | bump-minor | bump-major first if needed.
.PHONY: release clean bump-patch bump-minor bump-major

ZIP ?= tabby-extension.zip

release:
	@./scripts/package-extension.sh "$(ZIP)"

clean:
	rm -f $(ZIP)

bump-patch:
	@chmod +x scripts/bump-version.sh
	@./scripts/bump-version.sh patch

bump-minor:
	@chmod +x scripts/bump-version.sh
	@./scripts/bump-version.sh minor

bump-major:
	@chmod +x scripts/bump-version.sh
	@./scripts/bump-version.sh major
