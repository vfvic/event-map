<?php
/**
 * Plugin Name: VFVIC Event Map Server
 * Description: Provides a cached WordPress REST endpoint and shortcode for the VFVIC Veterans Diary map.
 * Version: 0.1.0
 * Author: VFVIC
 */

if (!defined('ABSPATH')) {
    exit;
}

final class VFVIC_Event_Map_Server {
    const OPTION_KEY = 'vfvic_event_map_settings';
    const EVENTS_TRANSIENT = 'vfvic_event_map_events';
    const META_TRANSIENT = 'vfvic_event_map_events_meta';
    const GEOCODE_PREFIX = 'vfvic_event_map_geo_';
    const RATE_LIMIT_PREFIX = 'vfvic_event_map_rate_';
    const CRON_HOOK = 'vfvic_event_map_refresh_cache';

    private $announcementRecurringIds = array(
        '2scpgqhjtjh5tc33cg3jm3ik5c',
        '30ed1sa1ev6k8kgp0ucg1mq24j',
    );

    private $announcementKeywords = array(
        'useful information',
        'veterans for veterans in care',
        'public announcement',
    );

    public function __construct() {
        add_filter('cron_schedules', array($this, 'add_cron_schedule'));
        add_action(self::CRON_HOOK, array($this, 'refresh_cache'));
        add_action('rest_api_init', array($this, 'register_routes'));
        add_action('admin_menu', array($this, 'register_settings_page'));
        add_action('admin_init', array($this, 'register_settings'));
        add_shortcode('vfvic_event_map', array($this, 'render_map_shortcode'));
    }

    public static function activate() {
        if (!wp_next_scheduled(self::CRON_HOOK)) {
            wp_schedule_event(time() + MINUTE_IN_SECONDS, 'vfvic_every_fifteen_minutes', self::CRON_HOOK);
        }
    }

    public static function deactivate() {
        wp_clear_scheduled_hook(self::CRON_HOOK);
    }

    public function add_cron_schedule($schedules) {
        if (!isset($schedules['vfvic_every_fifteen_minutes'])) {
            $schedules['vfvic_every_fifteen_minutes'] = array(
                'interval' => 15 * MINUTE_IN_SECONDS,
                'display'  => __('Every 15 Minutes (VFVIC)', 'vfvic-event-map-server'),
            );
        }

        return $schedules;
    }

    public function register_routes() {
        register_rest_route(
            'vfvic/v1',
            '/events',
            array(
                'methods'             => \WP_REST_Server::READABLE,
                'callback'            => array($this, 'handle_events_request'),
                'permission_callback' => '__return_true',
            )
        );
    }

    public function handle_events_request(\WP_REST_Request $request) {
        $limitCheck = $this->enforce_rate_limit();
        if (is_wp_error($limitCheck)) {
            return $limitCheck;
        }

        $refresh = current_user_can('manage_options') && $request->get_param('refresh');
        $events = $this->get_events_payload((bool) $refresh);

        if (is_wp_error($events)) {
            return $events;
        }

        $this->maybe_send_cors_headers();

        $meta = get_transient(self::META_TRANSIENT);
        $response = array(
            'events'      => $events,
            'count'       => count($events),
            'cached_at'   => !empty($meta['cached_at']) ? gmdate('c', (int) $meta['cached_at']) : null,
            'source_count'=> !empty($meta['source_count']) ? (int) $meta['source_count'] : count($events),
        );

        return rest_ensure_response($response);
    }

    public function refresh_cache() {
        $this->get_events_payload(true);
    }

    private function get_events_payload($forceRefresh = false) {
        $settings = $this->get_settings();
        $cacheTtl = max(300, (int) $settings['cache_ttl']);

        if (!$forceRefresh) {
            $cached = get_transient(self::EVENTS_TRANSIENT);
            if (is_array($cached)) {
                return $cached;
            }
        }

        if (empty($settings['google_api_key']) || empty($settings['calendar_id'])) {
            return new \WP_Error(
                'vfvic_missing_settings',
                'The Google Calendar API key and Calendar ID must be configured in Settings → VFVIC Event Map.',
                array('status' => 500)
            );
        }

        $items = $this->fetch_calendar_items($settings);
        if (is_wp_error($items)) {
            return $items;
        }

        $events = array();
        foreach ($items as $index => $item) {
            $normalised = $this->normalise_item($item, $index + 1, $settings);
            if (!empty($normalised)) {
                $events[] = $normalised;
            }
        }

        set_transient(self::EVENTS_TRANSIENT, $events, $cacheTtl);
        set_transient(
            self::META_TRANSIENT,
            array(
                'cached_at'    => time(),
                'source_count' => count($items),
            ),
            $cacheTtl
        );

        return $events;
    }

    private function fetch_calendar_items($settings) {
        $url = add_query_arg(
            array(
                'key'          => $settings['google_api_key'],
                'timeMin'      => gmdate('c'),
                'singleEvents' => 'true',
                'orderBy'      => 'startTime',
                'maxResults'   => 250,
            ),
            'https://www.googleapis.com/calendar/v3/calendars/' . rawurlencode($settings['calendar_id']) . '/events'
        );

        $response = wp_remote_get(
            $url,
            array(
                'timeout' => 20,
                'headers' => array('Accept' => 'application/json'),
            )
        );

        if (is_wp_error($response)) {
            return $response;
        }

        $status = (int) wp_remote_retrieve_response_code($response);
        $body = wp_remote_retrieve_body($response);

        if ($status !== 200) {
            return new \WP_Error(
                'vfvic_calendar_error',
                'Google Calendar request failed: ' . $status,
                array('status' => 502, 'body' => $body)
            );
        }

        $data = json_decode($body, true);
        if (!is_array($data) || !isset($data['items']) || !is_array($data['items'])) {
            return new \WP_Error(
                'vfvic_calendar_invalid',
                'Google Calendar did not return a valid items array.',
                array('status' => 502)
            );
        }

        return $data['items'];
    }

    private function normalise_item($item, $index, $settings) {
        if (!is_array($item)) {
            return null;
        }

        $title = sanitize_text_field($this->array_get($item, array('summary'), 'Untitled Event'));
        $description = $this->sanitise_description($this->array_get($item, array('description'), ''));
        $location = sanitize_text_field($this->array_get($item, array('location'), ''));
        $start = (array) $this->array_get($item, array('start'), array());
        $end = (array) $this->array_get($item, array('end'), array());
        $isAnnouncement = $this->is_announcement_item($item, $title);
        $categories = $this->categorise_event($title, $description);

        $event = array(
            'id'               => sanitize_text_field($this->array_get($item, array('id'), 'event-' . $index)),
            'title'            => $title,
            'summary'          => $title,
            'description'      => $description,
            'category'         => $categories['primary'],
            'categories'       => $categories['tags'],
            'date'             => $this->normalise_date($this->array_get($start, array('dateTime'), $this->array_get($start, array('date'), ''))),
            'time'             => $this->build_time_display($start, $end),
            'timeDisplay'      => $this->build_time_display($start, $end),
            'startTime'        => $this->format_time($this->array_get($start, array('dateTime'), '')),
            'endTime'          => $this->format_time($this->array_get($end, array('dateTime'), '')),
            'location'         => $location ?: 'Location TBD',
            'organizer'        => sanitize_text_field($this->array_get($item, array('organizer', 'displayName'), 'VFVIC')),
            'recurringEventId' => sanitize_text_field($this->array_get($item, array('recurringEventId'), '')),
            'start'            => $start,
            'end'              => $end,
        );

        if (!$isAnnouncement) {
            $coords = $this->get_coordinates_for_location($location, $title, $settings);
            if (!empty($coords['lat']) && !empty($coords['lng'])) {
                $event['lat'] = (float) $coords['lat'];
                $event['lng'] = (float) $coords['lng'];
            }
        }

        return $event;
    }

    private function is_announcement_item($item, $title) {
        $recurringId = sanitize_text_field($this->array_get($item, array('recurringEventId'), ''));
        if ($recurringId && in_array($recurringId, $this->announcementRecurringIds, true)) {
            return true;
        }

        $title = strtolower((string) $title);
        foreach ($this->announcementKeywords as $keyword) {
            if (strpos($title, $keyword) !== false) {
                return true;
            }
        }

        return false;
    }

    private function get_coordinates_for_location($location, $title, $settings) {
        $normalised = strtolower(trim((string) $location));
        if ($normalised === '') {
            return $this->fallback_coordinates_for_location($title);
        }

        $transientKey = self::GEOCODE_PREFIX . md5($normalised);
        $cached = get_transient($transientKey);
        if (is_array($cached) && isset($cached['lat'], $cached['lng'])) {
            return $cached;
        }

        $coords = null;
        if (!empty($settings['geocoding_api_key'])) {
            $coords = $this->geocode_with_google($location, $settings['geocoding_api_key']);
        }

        if (empty($coords)) {
            $coords = $this->fallback_coordinates_for_location($location);
        }

        if (!empty($coords['lat']) && !empty($coords['lng'])) {
            set_transient($transientKey, $coords, 30 * DAY_IN_SECONDS);
        }

        return $coords;
    }

    private function geocode_with_google($address, $apiKey) {
        $response = wp_remote_get(
            add_query_arg(
                array(
                    'address' => $address . ', Northeast England, UK',
                    'key'     => $apiKey,
                ),
                'https://maps.googleapis.com/maps/api/geocode/json'
            ),
            array(
                'timeout' => 15,
                'headers' => array('Accept' => 'application/json'),
            )
        );

        if (is_wp_error($response)) {
            return null;
        }

        $data = json_decode(wp_remote_retrieve_body($response), true);
        if (!is_array($data) || empty($data['results'][0]['geometry']['location'])) {
            return null;
        }

        $location = $data['results'][0]['geometry']['location'];
        return array(
            'lat' => (float) $location['lat'],
            'lng' => (float) $location['lng'],
        );
    }

    private function fallback_coordinates_for_location($location) {
        $map = array(
            'newcastle upon tyne' => array('lat' => 54.9783, 'lng' => -1.6178),
            'newcastle' => array('lat' => 54.9783, 'lng' => -1.6178),
            'sunderland' => array('lat' => 54.9069, 'lng' => -1.3838),
            'durham' => array('lat' => 54.7753, 'lng' => -1.5849),
            'middlesbrough' => array('lat' => 54.5742, 'lng' => -1.2349),
            'gateshead' => array('lat' => 54.9537, 'lng' => -1.6103),
            'south shields' => array('lat' => 54.9986, 'lng' => -1.4323),
            'north shields' => array('lat' => 55.0176, 'lng' => -1.4486),
            'tynemouth' => array('lat' => 55.0179, 'lng' => -1.4217),
            'whitley bay' => array('lat' => 55.0390, 'lng' => -1.4465),
            'blyth' => array('lat' => 55.1278, 'lng' => -1.5085),
            'ashington' => array('lat' => 55.1883, 'lng' => -1.5686),
            'hexham' => array('lat' => 54.9719, 'lng' => -2.1019),
        );

        $location = strtolower((string) $location);
        foreach ($map as $needle => $coords) {
            if (strpos($location, $needle) !== false) {
                $offset = $this->hash_offset($location);
                return array(
                    'lat' => $coords['lat'] + $offset['lat'],
                    'lng' => $coords['lng'] + $offset['lng'],
                );
            }
        }

        return array(
            'lat' => 54.9783,
            'lng' => -1.6178,
        );
    }

    private function hash_offset($value) {
        $hash = crc32((string) $value);
        $lat = (($hash % 1000) / 1000 - 0.5) * 0.008;
        $lng = (((int) ($hash / 1000) % 1000) / 1000 - 0.5) * 0.008;

        return array('lat' => $lat, 'lng' => $lng);
    }

    private function categorise_event($title, $description) {
        $combined = strtolower($title . ' ' . $description);
        $tags = array();

        if (strpos($combined, 'breakfast') !== false) {
            $tags[] = 'breakfast-club';
        }
        if (strpos($combined, 'drop in') !== false || strpos($combined, 'drop-in') !== false) {
            $tags[] = 'drop-in';
        }
        if (strpos($combined, 'support') !== false || strpos($combined, 'wellbeing') !== false || strpos($combined, 'mental health') !== false) {
            $tags[] = 'support';
        }
        if (strpos($combined, 'meeting') !== false) {
            $tags[] = 'meeting';
        }
        if (strpos($combined, 'walk') !== false || strpos($combined, 'sport') !== false || strpos($combined, 'surf') !== false) {
            $tags[] = 'sport';
        }
        if (strpos($combined, 'social') !== false || strpos($combined, 'coffee') !== false || strpos($combined, 'breakfast') !== false) {
            $tags[] = 'social';
        }

        if (empty($tags)) {
            $tags[] = 'other';
        }

        return array(
            'primary' => $tags[0],
            'tags'    => array_values(array_unique($tags)),
        );
    }

    private function sanitise_description($text) {
        $text = html_entity_decode((string) $text, ENT_QUOTES | ENT_HTML5, 'UTF-8');
        $text = wp_kses_post($text);
        $text = preg_replace('/<br\s*\/?>/i', "\n", $text);
        $text = preg_replace('/<\/p>/i', "\n\n", $text);
        $text = wp_strip_all_tags($text);
        $text = preg_replace("/\n{3,}/", "\n\n", $text);

        return trim((string) $text);
    }

    private function normalise_date($value) {
        if (empty($value)) {
            return '';
        }

        $timestamp = strtotime($value);
        return $timestamp ? gmdate('Y-m-d', $timestamp) : '';
    }

    private function format_time($value) {
        if (empty($value)) {
            return '';
        }

        $timestamp = strtotime($value);
        return $timestamp ? gmdate('H:i', $timestamp) : '';
    }

    private function build_time_display($start, $end) {
        $startTime = $this->format_time($this->array_get($start, array('dateTime'), ''));
        $endTime = $this->format_time($this->array_get($end, array('dateTime'), ''));

        if (!$startTime && !$endTime) {
            return 'All day';
        }

        if ($startTime && $endTime && $startTime !== $endTime) {
            return $startTime . ' - ' . $endTime;
        }

        return $startTime ?: 'Time TBD';
    }

    private function array_get($array, $path, $default = '') {
        $value = $array;
        foreach ($path as $segment) {
            if (!is_array($value) || !array_key_exists($segment, $value)) {
                return $default;
            }
            $value = $value[$segment];
        }

        return $value;
    }

    private function enforce_rate_limit() {
        if (current_user_can('manage_options')) {
            return true;
        }

        $ip = isset($_SERVER['REMOTE_ADDR']) ? sanitize_text_field(wp_unslash($_SERVER['REMOTE_ADDR'])) : 'unknown';
        $key = self::RATE_LIMIT_PREFIX . md5($ip);
        $limit = (int) apply_filters('vfvic_event_map_rate_limit', 60);
        $data = get_transient($key);

        if (!is_array($data)) {
            $data = array('count' => 0);
        }

        if ($data['count'] >= $limit) {
            return new \WP_Error(
                'vfvic_rate_limited',
                'Too many requests. Please try again in a minute.',
                array('status' => 429)
            );
        }

        $data['count']++;
        set_transient($key, $data, MINUTE_IN_SECONDS);
        return true;
    }

    private function maybe_send_cors_headers() {
        $settings = $this->get_settings();
        $allowedOrigin = trim((string) $settings['allowed_origin']);

        if ($allowedOrigin !== '') {
            header('Access-Control-Allow-Origin: ' . esc_url_raw($allowedOrigin));
            header('Vary: Origin');
        }
    }

    public function register_settings_page() {
        add_options_page(
            'VFVIC Event Map',
            'VFVIC Event Map',
            'manage_options',
            'vfvic-event-map-settings',
            array($this, 'render_settings_page')
        );
    }

    public function register_settings() {
        register_setting(
            'vfvic_event_map_settings_group',
            self::OPTION_KEY,
            array($this, 'sanitise_settings_input')
        );

        add_settings_section(
            'vfvic_event_map_main',
            'Endpoint settings',
            '__return_false',
            'vfvic-event-map-settings'
        );

        $fields = array(
            'google_api_key' => array('label' => 'Google Calendar API Key', 'type' => 'password'),
            'calendar_id' => array('label' => 'Google Calendar ID', 'type' => 'text'),
            'geocoding_api_key' => array('label' => 'Google Geocoding API Key (optional)', 'type' => 'password'),
            'map_url' => array('label' => 'Uploaded map URL', 'type' => 'url'),
            'cache_ttl' => array('label' => 'Cache TTL (seconds)', 'type' => 'number'),
            'allowed_origin' => array('label' => 'Allowed origin for CORS (optional)', 'type' => 'url'),
        );

        foreach ($fields as $key => $field) {
            add_settings_field(
                $key,
                $field['label'],
                array($this, 'render_settings_field'),
                'vfvic-event-map-settings',
                'vfvic_event_map_main',
                array(
                    'key'  => $key,
                    'type' => $field['type'],
                )
            );
        }
    }

    public function sanitise_settings_input($input) {
        $input = is_array($input) ? $input : array();

        return array(
            'google_api_key'     => sanitize_text_field($this->array_get($input, array('google_api_key'), '')),
            'calendar_id'        => sanitize_text_field($this->array_get($input, array('calendar_id'), '')),
            'geocoding_api_key'  => sanitize_text_field($this->array_get($input, array('geocoding_api_key'), '')),
            'map_url'            => esc_url_raw($this->array_get($input, array('map_url'), '')),
            'cache_ttl'          => max(300, (int) $this->array_get($input, array('cache_ttl'), 900)),
            'allowed_origin'     => esc_url_raw($this->array_get($input, array('allowed_origin'), '')),
        );
    }

    public function render_settings_field($args) {
        $settings = $this->get_settings();
        $key = $args['key'];
        $type = $args['type'];
        $value = isset($settings[$key]) ? $settings[$key] : '';

        printf(
            '<input type="%1$s" name="%2$s[%3$s]" value="%4$s" class="regular-text" />',
            esc_attr($type),
            esc_attr(self::OPTION_KEY),
            esc_attr($key),
            esc_attr($value)
        );
    }

    public function render_settings_page() {
        if (!current_user_can('manage_options')) {
            return;
        }

        $endpointUrl = rest_url('vfvic/v1/events');
        ?>
        <div class="wrap">
            <h1>VFVIC Event Map</h1>
            <p>Configure the live events endpoint for the uploaded VFVIC map bundle.</p>
            <p><strong>REST endpoint:</strong> <code><?php echo esc_html($endpointUrl); ?></code></p>
            <p><strong>Shortcode:</strong> <code>[vfvic_event_map]</code></p>
            <form method="post" action="options.php">
                <?php
                settings_fields('vfvic_event_map_settings_group');
                do_settings_sections('vfvic-event-map-settings');
                submit_button();
                ?>
            </form>
        </div>
        <?php
    }

    public function render_map_shortcode($atts) {
        $atts = shortcode_atts(
            array(
                'src'    => '',
                'height' => '850',
                'title'  => 'VFVIC Veterans Diary Map',
            ),
            $atts,
            'vfvic_event_map'
        );

        $settings = $this->get_settings();
        $src = $atts['src'] ? $atts['src'] : $settings['map_url'];
        if (empty($src)) {
            return '<p>VFVIC map URL is not configured yet.</p>';
        }

        $endpoint = rest_url('vfvic/v1/events');
        $separator = strpos($src, '?') === false ? '?' : '&';
        $iframeSrc = $src . $separator . 'dataSource=' . rawurlencode($endpoint);
        $height = max(400, (int) $atts['height']);

        return sprintf(
            '<iframe src="%1$s" width="100%%" height="%2$d" style="border:0;" loading="lazy" title="%3$s"></iframe>',
            esc_url($iframeSrc),
            $height,
            esc_attr($atts['title'])
        );
    }

    private function get_settings() {
        $defaults = array(
            'google_api_key'    => defined('VFVIC_GOOGLE_CALENDAR_API_KEY') ? VFVIC_GOOGLE_CALENDAR_API_KEY : '',
            'calendar_id'       => defined('VFVIC_GOOGLE_CALENDAR_ID') ? VFVIC_GOOGLE_CALENDAR_ID : '',
            'geocoding_api_key' => defined('VFVIC_GOOGLE_GEOCODING_API_KEY') ? VFVIC_GOOGLE_GEOCODING_API_KEY : '',
            'map_url'           => '',
            'cache_ttl'         => 900,
            'allowed_origin'    => '',
        );

        $saved = get_option(self::OPTION_KEY, array());
        return wp_parse_args(is_array($saved) ? $saved : array(), $defaults);
    }
}

$vfvicEventMapServer = new VFVIC_Event_Map_Server();
register_activation_hook(__FILE__, array('VFVIC_Event_Map_Server', 'activate'));
register_deactivation_hook(__FILE__, array('VFVIC_Event_Map_Server', 'deactivate'));