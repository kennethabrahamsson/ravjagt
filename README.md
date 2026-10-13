# Ravjagt

Privat web-app til telefonen: hvor og hvornår der er rav på Danmarks kyster – og en logbog, der gør modellen klogere for hver tur.

## Hvad den gør

- **Hele Danmarks kyst** i strækninger på ca. 1,5 km. Kun *ravkyst* farves grøn/gul/rød: strækninger med mindst 50 km åbent vand i mindst to retninger ud fra stranden. Fjorde, bugter og havne vises som tynde grå linjer. Høfder og moler ved ravkyst vises fra zoom 13.
- **Filter:** *Nær mig* (30 km), *Kortudsnit* eller *Hele landet* styrer listen, tidslinjen og dommen øverst.
- **Tidslinje** for de næste 5 døgn. Tryk på en time for at se kortet på det tidspunkt. Mørke timer er markeret (UV-lygten virker kun i mørke).
- **Start tur her** sætter en nål, hvor du starter. En pil og en afstand viser vej tilbage, også når alt ligner hinanden i mørke. Skærmen holdes tændt.
- **+ Fund her** sætter et fund på kortet. Ved afslutning: antal, UV ja/nej, note.
- **Rammer modellen?** viser fund pr. time fordelt på grøn/gul/rød, så vi kan se, om farverne passer.
- Virker offline med det seneste vejr. Din position forlader aldrig telefonen, ud over de ture du selv gemmer.
- **Gemt i Airtable:** turene synkroniseres til tabellen `Ture` i den private Airtable-base `Ravjagt` – én række pr. tur med læsbare kolonner (start, fund, UV, note, sted, farve, score, vind, bølger, vandstand, mørke) og det fulde spor i `Data`. Fund, UV-lygte og note kan rettes i Airtable og hentes tilbage. Ændringer lægges i kø uden net. Appen opretter selv tabellen; telefonen bruger et personligt Airtable-token med adgang til netop den base, og det gemmes kun på telefonen.

## Modellen (v0.3 – en hypotese)

Scoren svarer på: **skal jeg gå ud nu med UV-lygten?** Grøn kræver, at vinden har lagt sig, og at det er mørkt. Dagslys kan højst blive gul.

Se `js/model.js`.

| Faktor | Hvorfor |
|---|---|
| Pålandsvind i snit over 12 timer, de sidste 3 døgn (aftager efter 12 t), vægtet med åbent vand i vindens retning | Rav driver ind med tang efter vedvarende pålandsvind over åbent hav |
| Bølgehøjde | Mere energi = mere materiale op fra bunden |
| Stormen står stadig på → lavere | Rav ruller i brændingen, og det er farligt at gå |
| Dagslys → højst gul | UV-lygten virker kun i mørke |
| Fralandsvind nu → lavere | Intet nyt kommer ind |
| Lavvande → højere | Mere strand fri |
| Strøm langs kysten + høfder/moler | Materialet samles på den side af høfden, strømmen kommer fra – appen siger hvilken |

Grøn ≥ 55, gul ≥ 30. Vægtene er sat efter erfaringsregler, ikke målt. De skal kalibreres med egne ture – også dem uden fund.

## Data

- Vejr og hav: [Open-Meteo](https://open-meteo.com) (forecast og marine), to punkter. Historisk vejr kan hentes fra Open-Meteos arkiv, så vi behøver ikke selv logge vejret – kun turene.
- Kyst, høfder, moler, bølgebrydere og stednavne: © OpenStreetMap-bidragydere (Overpass, hentet 13.10.2026). Nabolandenes kyst (til at beregne åbent vand): Natural Earth 10m. Bygges med `python3 -I tools/build_coast.py` → `data/dk.json` (rådata i `tools/cache/`, ikke i git).
- Vejr: 66 punkter langs kysten (Open-Meteo forecast + marine).
- Kort: Esri Dark Gray Canvas og World Imagery.

## Kør lokalt

```bash
python3 -m http.server 8765
```

Åbn `http://127.0.0.1:8765/?demo` for en simuleret gåtur ved Søndervig.

## Næste skridt

- Kalibrér modellen på egne ture + Open-Meteo-arkivet.
- Udvid til flere kyster (fx Skallingen, Blåvandshuk, Thyborøn).
