# Ravjagt til iPhone. Faste kommandoer:
#   make gen     – lav Xcode-projektet ud fra project.yml
#   make build   – byg til simulatoren
#   make run     – byg og start i simulatoren
#   make device  – byg og installér på din egen iPhone (USB eller wifi, telefonen skal være låst op og "Stol på")
#   make install – installér den sidst byggede app uden at bygge igen (hurtigt – hold telefonen låst op)
# Gratis Personal Team: profilen udløber efter 7 dage – kør `make device` igen.
SIM  ?= iPhone 18 Pro
DEST  = platform=iOS Simulator,name=$(SIM)
BUNDLE = dk.kennethabrahamsson.ravjagt

.PHONY: gen build run device install clean

gen:
	xcodegen generate --quiet

build: gen
	xcodebuild -project Ravjagt.xcodeproj -scheme Ravjagt -destination '$(DEST)' -derivedDataPath .build/dd build -quiet

run: build
	xcrun simctl boot '$(SIM)' 2>/dev/null || true
	xcrun simctl install booted .build/dd/Build/Products/Debug-iphonesimulator/Ravjagt.app
	xcrun simctl launch booted $(BUNDLE)

device: gen
	@test -f Local.xcconfig || { echo "Mangler Local.xcconfig med DEVELOPMENT_TEAM"; exit 1; }
	xcodebuild -project Ravjagt.xcodeproj -scheme Ravjagt -configuration Release -destination 'generic/platform=iOS' -derivedDataPath .build/dd -allowProvisioningUpdates build -quiet
	@$(MAKE) --no-print-directory install

install:
	@echo "Lås iPhonen op nu og hold skærmen tændt …"
	@xcrun devicectl list devices --json-output .build/devices.json >/dev/null 2>&1; \
	udid=$${DEVICE:-$$(python3 -c "import json; d=json.load(open('.build/devices.json'))['result']['devices']; print(next((x['identifier'] for x in d if x['hardwareProperties'].get('reality') == 'physical' and x['connectionProperties'].get('pairingState') == 'paired'), ''))")}; \
	test -n "$$udid" || { echo "Ingen parret iPhone fundet – sæt telefonen til, lås den op og tryk Stol på"; exit 1; }; \
	xcrun devicectl device install app --device $$udid .build/dd/Build/Products/Release-iphoneos/Ravjagt.app && \
	{ xcrun devicectl device process launch --device $$udid $(BUNDLE) >/dev/null 2>&1 && echo "Installeret og startet." || echo "Installeret – telefonen var låst, så åbn Ravjagt selv."; }

clean:
	rm -rf .build Ravjagt.xcodeproj
