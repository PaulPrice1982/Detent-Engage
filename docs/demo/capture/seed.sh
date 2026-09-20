set -u
B=${BASE:-http://127.0.0.1:8901}
J=jar.txt
tok() { curl -s -b $J -c $J "$B$1" | grep -o 'name="csrf" value="[^"]*"' | head -1 | sed 's/.*value="//;s/"//'; }

mk() { # name tenant email country vat manager plan term interval start day notice uplift credits seats convs voice cap
  C=$(tok /console/new)
  curl -s -b $J -c $J -X POST "$B/console/new" -o /dev/null -w "$2 -> %{http_code} %{redirect_url}\n" \
    --data-urlencode "csrf=$C" \
    --data-urlencode "name=$1" --data-urlencode "tenantId=$2" --data-urlencode "billingEmail=$3" \
    --data-urlencode "countryCode=$4" --data-urlencode "vatNumber=$5" --data-urlencode "accountManager=$6" \
    --data-urlencode "planCode=$7" --data-urlencode "term=$8" --data-urlencode "billingInterval=$9" \
    --data-urlencode "startDate=${10}" --data-urlencode "billingDay=${11}" --data-urlencode "noticePeriodDays=${12}" \
    --data-urlencode "renewalUplift=${13}" --data-urlencode "monthlyCredits=${14}" --data-urlencode "seats=${15}" \
    --data-urlencode "conversations=${16}" --data-urlencode "voiceMinutes=${17}" --data-urlencode "spendCap=${18}"
}

mk "Northwind Logistics Group" "t_northwind" "ap@northwind.example" "GB" "GB418221944" "Tony Marsh" \
   "enterprise" "thirty_six_months" "annual" "2026-01-01" "1" "180" "4.5" "12000" "240" "60000" "9000" "15000"

mk "Kestrel Dental Partners" "t_kestrel" "finance@kestreldental.example" "GB" "GB332918440" "Tom Reilly" \
   "growth" "twelve_months" "monthly" "2026-04-01" "14" "90" "3.0" "1500" "40" "8000" "1200" "2200"

mk "Halden Renewables" "t_halden" "accounts@halden.example" "GB" "" "Tony Marsh" \
   "command" "twenty_four_months" "monthly" "2025-11-01" "7" "120" "3.5" "4000" "90" "20000" "3000" "5500"

mk "Barrowfield Care Homes" "t_barrowfield" "ledger@barrowfield.example" "GB" "GB771230098" "Tom Reilly" \
   "starter" "rolling_monthly" "monthly" "2026-08-15" "1" "30" "0" "350" "8" "1500" "200" "500"
